import { EntityManager } from '@mikro-orm/postgresql';
import { v7 as uuidv7 } from 'uuid';
import { executeInTransaction } from '../../database/execute-in-transaction.js';
import { CurrencyMismatchError, InsufficientBalanceError, IdempotencyConflictError, WalletNotFoundError } from '../../shared/domain/errors/domain-error.js';
import { WagerTransactionProcessedEvent } from '../../shared/domain/events/wager-transaction-processed.event.js';
import { WagerTransactionRejectedEvent } from '../../shared/domain/events/wager-transaction-rejected.event.js';
import { WalletBalanceChangedEvent } from '../../shared/domain/events/wallet-balance-changed.event.js';
import { Money } from '../../shared/domain/value-objects/money.js';
import { Wallet } from '../../wallet/domain/entities/wallet.entity.js';
import { WalletLedgerEntry } from '../../wallet/domain/entities/wallet-ledger-entry.entity.js';
import { LedgerDirection } from '../../wallet/domain/enums/ledger-direction.enum.js';
import { WagerTransaction } from '../domain/entities/wager-transaction.entity.js';
import { WagerTransactionKind } from '../domain/enums/wager-transaction-kind.enum.js';
import { WagerTransactionStatus } from '../domain/enums/wager-transaction-status.enum.js';

export interface ProcessWagerInput {
  providerId: string; externalTransactionId: string; idempotencyKey: string;
  playerId: string; walletId: string; roundId: string; gameId: string;
  kind: WagerTransactionKind; money: { amount: string; currency: string };
  referenceExternalTransactionId?: string; correlationId?: string;
  inboxMessage?: { consumerName: string; messageId: string };
}
export interface ProcessWagerResult {
  transactionId: string; status: WagerTransactionStatus; balance: { amount: string; currency: string };
  idempotentReplay: boolean; failureCode?: string;
}

export class InboxMessageAlreadyProcessed extends Error {
  constructor() {
    super('SQS message is already recorded in the inbox');
    this.name = 'InboxMessageAlreadyProcessed';
  }
}

/**
 * Applies a wager and writes its audit/event records in one PostgreSQL transaction.
 * The row lock is per wallet, so unrelated wallets can still make progress in parallel.
 */
export class ProcessWagerTransaction {
  constructor(private readonly em: EntityManager) {}

  async execute(input: ProcessWagerInput): Promise<ProcessWagerResult> {
    const money = Money.from(input.money);
    if (!money.isPositive()) throw new Error('Transaction amount must be greater than zero');
    if (input.kind === WagerTransactionKind.Opening) throw new Error('OPENING is an internal transaction');
    if (input.kind === WagerTransactionKind.Refund || input.kind === WagerTransactionKind.Rollback) {
      throw new Error('REFUND and ROLLBACK require reference validation and are not enabled in this first slice');
    }
    const { inboxMessage, ...wagerInput } = input;
    const wager = WagerTransaction.create({ ...wagerInput, money });

    try {
      return await this.em.transactional(async (tx) => {
        const execute = (query: string, params: unknown[] = []) => executeInTransaction<any[]>(tx, query, params);
        if (inboxMessage) {
          const insertedInbox = await execute(
            'insert into inbox_message (id, consumer_name, message_id, processed_at) values (?, ?, ?, now()) on conflict (consumer_name, message_id) do nothing returning id',
            [uuidv7(), inboxMessage.consumerName, inboxMessage.messageId],
          );
          if (insertedInbox.length === 0) throw new InboxMessageAlreadyProcessed();
        }
        // Lock this wallet before checking the idempotency key a second time.
        // This makes parallel retries on a hot wallet observe the first commit.
        const [walletRow] = await execute(
          'select id, player_id as "playerId", currency, balance::text, version, created_at as "createdAt", updated_at as "updatedAt" from wallet where id = ? for update',
          [input.walletId],
        );
        if (!walletRow) throw new WalletNotFoundError(input.walletId);

        const [existing] = await execute(
          'select id, payload_hash as "payloadHash", status, failure_code as "failureCode", resulting_balance::text as "resultingBalance", currency from wager_transaction where provider_id = ? and idempotency_key = ?',
          [input.providerId, input.idempotencyKey],
        );
        if (existing) {
          if (existing.payloadHash !== wager.payloadHash) throw new IdempotencyConflictError(input.idempotencyKey);
          return {
            transactionId: existing.id,
            status: existing.status,
            balance: { amount: String(existing.resultingBalance), currency: existing.currency },
            idempotentReplay: true,
            failureCode: existing.failureCode ?? undefined,
          };
        }

        const wallet = Wallet.rehydrate({
          id: walletRow.id, playerId: walletRow.playerId, currency: walletRow.currency,
          balance: String(walletRow.balance), version: walletRow.version,
          createdAt: walletRow.createdAt, updatedAt: walletRow.updatedAt,
        });
        if (wallet.playerId !== input.playerId) wager.reject('PLAYER_WALLET_MISMATCH');

        const now = new Date();
        let ledger: WalletLedgerEntry | undefined;
        if (!wager.isTerminal() && wager.affectsBalance()) {
          const before = wallet.balance;
          try {
            if (wager.ledgerDirectionFor() === LedgerDirection.Debit) wallet.debit(money);
            else wallet.credit(money);
            ledger = WalletLedgerEntry.create({
              walletId: wallet.id, transactionId: wager.id, direction: wager.ledgerDirectionFor(),
              money, balanceBefore: before, balanceAfter: wallet.balance, walletVersion: wallet.version,
            });
          } catch (error) {
            if (!(error instanceof InsufficientBalanceError) && !(error instanceof CurrencyMismatchError)) throw error;
            wager.reject(error.code);
          }
        }
        if (!wager.isTerminal()) wager.markProcessed();

        const state = wager.toState();
        await execute(
          `insert into wager_transaction (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id, status, failure_code, resulting_balance, processed_at, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [state.id, state.providerId, state.externalTransactionId, state.idempotencyKey, state.payloadHash, state.walletId,
            state.playerId, state.roundId, state.gameId, state.kind, state.money, state.currency,
            state.referenceExternalTransactionId ?? null, state.status, state.failureCode ?? null, wallet.balance.getAmount(),
            state.status === WagerTransactionStatus.Processed || state.status === WagerTransactionStatus.Rejected ? now : null, now, now],
        );

        if (ledger) {
          const entry = ledger.toState();
          await execute(
            `update wallet set balance = ?, version = ?, updated_at = ? where id = ?`,
            [wallet.balance.getAmount(), wallet.version, wallet.updatedAt, wallet.id],
          );
          await execute(
            `insert into wallet_ledger_entry (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [entry.id, entry.walletId, entry.transactionId, entry.direction, entry.money, entry.currency,
              entry.balanceBefore, entry.balanceAfter, entry.walletVersion, entry.createdAt],
          );
        }

        const correlationId = input.correlationId ?? wager.id;
        const transactionEvent = wager.status === WagerTransactionStatus.Rejected
          ? WagerTransactionRejectedEvent.from({ aggregateId: wager.id, correlationId, data: {
              transactionId: wager.id, externalTransactionId: wager.externalTransactionId, providerId: wager.providerId,
              playerId: wager.playerId, walletId: wager.walletId, roundId: wager.roundId, gameId: wager.gameId,
              kind: wager.kind, money: money.toJSON(), failureCode: wager.failureCode ?? 'BUSINESS_REJECTED',
            } })
          : WagerTransactionProcessedEvent.from({ aggregateId: wager.id, correlationId, data: {
              transactionId: wager.id, externalTransactionId: wager.externalTransactionId, providerId: wager.providerId,
              playerId: wager.playerId, walletId: wager.walletId, roundId: wager.roundId, gameId: wager.gameId,
              kind: wager.kind, money: money.toJSON(), status: wager.status, walletBalance: wallet.balance.toJSON(), walletVersion: wallet.version,
            } });
        const events = [transactionEvent.toJSON()];
        if (ledger) events.push(WalletBalanceChangedEvent.from({ aggregateId: wallet.id, correlationId, causationId: wager.id, data: {
          walletId: wallet.id, transactionId: wager.id, direction: ledger.direction, money: money.toJSON(),
          balanceBefore: ledger.balanceBefore.toJSON(), balanceAfter: ledger.balanceAfter.toJSON(), walletVersion: wallet.version,
        } }).toJSON());
        for (const event of events) {
          await execute(
            'insert into outbox_message (id, event_id, event_type, aggregate_id, payload, occurred_at, attempts, created_at) values (?, ?, ?, ?, ?::jsonb, ?, 0, ?)',
            [uuidv7(), event.eventId, event.eventType, event.aggregateId, JSON.stringify(event), event.occurredAt, now],
          );
        }

        return { transactionId: wager.id, status: wager.status, balance: wallet.balance.toJSON(), idempotentReplay: false, failureCode: wager.failureCode };
      });
    } catch (error) {
      // A duplicate key can race on different wallets. The database unique
      // constraint arbitrates; after rollback, load and compare the winner.
      if ((error as { code?: string })?.code === '23505') {
        const existing = await this.em.getConnection().execute<any[]>(
          'select id, payload_hash as "payloadHash", status, failure_code as "failureCode", resulting_balance::text as "resultingBalance", currency from wager_transaction where provider_id = ? and idempotency_key = ?',
          [input.providerId, input.idempotencyKey],
        );
        if (existing[0]) {
          if (existing[0].payloadHash !== wager.payloadHash) throw new IdempotencyConflictError(input.idempotencyKey);
          return { transactionId: existing[0].id, status: existing[0].status, balance: { amount: String(existing[0].resultingBalance), currency: existing[0].currency }, idempotentReplay: true, failureCode: existing[0].failureCode ?? undefined };
        }
      }
      throw error;
    }
  }
}
