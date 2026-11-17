import { EntityManager } from '@mikro-orm/postgresql';
import { v7 as uuidv7 } from 'uuid';
import { DuplicateWalletError } from '../../shared/domain/errors/domain-error.js';
import { WalletBalanceChangedEvent } from '../../shared/domain/events/wallet-balance-changed.event.js';
import { WagerTransactionProcessedEvent } from '../../shared/domain/events/wager-transaction-processed.event.js';
import { Money } from '../../shared/domain/value-objects/money.js';
import { WagerTransaction } from '../../wagering/domain/entities/wager-transaction.entity.js';
import { WagerTransactionKind } from '../../wagering/domain/enums/wager-transaction-kind.enum.js';
import { Wallet } from '../domain/entities/wallet.entity.js';
import { WalletLedgerEntry } from '../domain/entities/wallet-ledger-entry.entity.js';
import { LedgerDirection } from '../domain/enums/ledger-direction.enum.js';

export interface CreateWalletInput {
  playerId: string;
  initialBalance: { amount: string; currency: string };
}

export class CreateWallet {
  constructor(private readonly em: EntityManager) {}

  async execute(input: CreateWalletInput) {
    const initialBalance = Money.from(input.initialBalance);
    if (initialBalance.isNegative()) throw new Error('Initial balance cannot be negative');

    const wallet = Wallet.open({
      playerId: input.playerId,
      currency: initialBalance.currency,
      initialBalance,
    });
    const state = wallet.toState();

    try {
      await this.em.transactional(async (tx) => {
        const connection = tx.getConnection();
        await connection.execute(
          'insert into wallet (id, player_id, currency, balance, version, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)',
          [state.id, state.playerId, state.currency, state.balance, state.version, state.createdAt, state.updatedAt],
        );

        // A zero opening balance creates no financial movement and therefore no ledger entry.
        if (initialBalance.isPositive()) {
          const opening = WagerTransaction.create({
            providerId: 'system',
            externalTransactionId: `opening:${wallet.id}`,
            idempotencyKey: `opening:${wallet.id}`,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: `opening:${wallet.id}`,
            gameId: 'internal',
            kind: WagerTransactionKind.Opening,
            money: initialBalance,
          });
          opening.markProcessed();
          const openingState = opening.toState();
          const zero = Money.zero(wallet.currency);
          const ledger = WalletLedgerEntry.create({
            walletId: wallet.id,
            transactionId: opening.id,
            direction: LedgerDirection.Credit,
            money: initialBalance,
            balanceBefore: zero,
            balanceAfter: wallet.balance,
            walletVersion: wallet.version,
          }).toState();

          await connection.execute(
            `insert into wager_transaction (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, resulting_balance, processed_at, created_at, updated_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [openingState.id, openingState.providerId, openingState.externalTransactionId, openingState.idempotencyKey,
              openingState.payloadHash, openingState.walletId, openingState.playerId, openingState.roundId,
              openingState.gameId, openingState.kind, openingState.money, openingState.currency,
              openingState.status, wallet.balance.getAmount(), new Date(), openingState.createdAt, openingState.updatedAt],
          );
          await connection.execute(
            `insert into wallet_ledger_entry (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [ledger.id, ledger.walletId, ledger.transactionId, ledger.direction, ledger.money, ledger.currency,
              ledger.balanceBefore, ledger.balanceAfter, ledger.walletVersion, ledger.createdAt],
          );

          const correlationId = opening.id;
          const events = [
            WagerTransactionProcessedEvent.from({ aggregateId: opening.id, correlationId, data: {
              transactionId: opening.id, externalTransactionId: opening.externalTransactionId,
              providerId: opening.providerId, playerId: wallet.playerId, walletId: wallet.id,
              roundId: opening.roundId, gameId: opening.gameId, kind: opening.kind,
              money: initialBalance.toJSON(), status: opening.status,
              walletBalance: wallet.balance.toJSON(), walletVersion: wallet.version,
            } }).toJSON(),
            WalletBalanceChangedEvent.from({ aggregateId: wallet.id, correlationId, causationId: opening.id, data: {
              walletId: wallet.id, transactionId: opening.id, direction: LedgerDirection.Credit,
              money: initialBalance.toJSON(), balanceBefore: zero.toJSON(), balanceAfter: wallet.balance.toJSON(),
              walletVersion: wallet.version,
            } }).toJSON(),
          ];
          for (const event of events) {
            await connection.execute(
              'insert into outbox_message (id, event_id, event_type, aggregate_id, payload, occurred_at, attempts, created_at) values (?, ?, ?, ?, ?::jsonb, ?, 0, ?)',
              [uuidv7(), event.eventId, event.eventType, event.aggregateId, JSON.stringify(event), event.occurredAt, new Date()],
            );
          }
        }
      });
    } catch (error) {
      const wrapped = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
      const pgError = wrapped.cause ?? wrapped;
      if (pgError.code === '23505' && pgError.constraint === 'wallet_player_currency_uq') {
        throw new DuplicateWalletError(input.playerId, initialBalance.currency);
      }
      throw error;
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}
