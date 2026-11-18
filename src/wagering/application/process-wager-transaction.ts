import { EntityManager } from '@mikro-orm/postgresql';
import { v7 as uuidv7 } from 'uuid';
import { executeInTransaction } from '../../database/execute-in-transaction.js';
import { CurrencyMismatchError, InsufficientBalanceError, IdempotencyConflictError, ReferenceAlreadyReversedError, WalletNotFoundError } from '../../shared/domain/errors/domain-error.js';
import { WagerTransactionProcessedEvent } from '../../shared/domain/events/wager-transaction-processed.event.js';
import { WagerTransactionPendingReferenceEvent } from '../../shared/domain/events/wager-transaction-pending-reference.event.js';
import { WagerTransactionRejectedEvent } from '../../shared/domain/events/wager-transaction-rejected.event.js';
import { WalletBalanceChangedEvent } from '../../shared/domain/events/wallet-balance-changed.event.js';
import { FailureCode } from '../../shared/domain/errors/failure-codes.js';
import { Money } from '../../shared/domain/value-objects/money.js';
import { Wallet } from '../../wallet/domain/entities/wallet.entity.js';
import { WalletLedgerEntry } from '../../wallet/domain/entities/wallet-ledger-entry.entity.js';
import { LedgerDirection } from '../../wallet/domain/enums/ledger-direction.enum.js';
import { WagerTransaction } from '../domain/entities/wager-transaction.entity.js';
import { WagerTransactionKind } from '../domain/enums/wager-transaction-kind.enum.js';
import { WagerTransactionStatus } from '../domain/enums/wager-transaction-status.enum.js';
import { AppMetrics } from '../../observability/app-metrics.js';

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

interface ReferenceRow {
  id: string; providerId: string; externalTransactionId: string; playerId: string; walletId: string;
  roundId: string; kind: WagerTransactionKind; amount: string; currency: string; status: WagerTransactionStatus;
}
type SqlExecutor = <T = any[]>(query: string, params?: unknown[]) => Promise<T>;

interface PendingWagerRow {
  id: string; externalTransactionId: string; providerId: string; playerId: string; walletId: string;
  roundId: string; gameId: string; kind: WagerTransactionKind; money: string; currency: string;
  status: WagerTransactionStatus; referenceExternalTransactionId: string; referenceTransactionId?: string;
  idempotencyKey: string; payloadHash: string; failureCode?: string; createdAt: Date; updatedAt: Date;
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
  constructor(private readonly em: EntityManager, private readonly metrics: AppMetrics = new AppMetrics()) {}

  /** Persists an audit-only terminal state after all SQS delivery attempts fail. */
  async failPermanently(input: ProcessWagerInput, failureCode: FailureCode): Promise<ProcessWagerResult> {
    const startedAt = performance.now();
    const money = Money.from(input.money);
    if (!money.isPositive()) throw new Error('Transaction amount must be greater than zero');
    if (input.kind === WagerTransactionKind.Opening) throw new Error('OPENING is an internal transaction');
    const wager = WagerTransaction.create({ ...input, money });
    wager.fail(failureCode);

    const result = await this.em.transactional(async (tx) => {
      const execute = <T = any[]>(query: string, params: unknown[] = []) => executeInTransaction<T>(tx, query, params);
      const [walletRow] = await execute<any[]>(
        'select id, player_id as "playerId", currency, balance::text from wallet where id = ? for update',
        [input.walletId],
      );
      if (!walletRow) throw new WalletNotFoundError(input.walletId);

      const [existing] = await execute<any[]>(
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

      const state = wager.toState();
      const now = new Date();
      await execute(
        `insert into wager_transaction (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, failure_code, resulting_balance, processed_at, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [state.id, state.providerId, state.externalTransactionId, state.idempotencyKey, state.payloadHash, state.walletId,
          state.playerId, state.roundId, state.gameId, state.kind, state.money, state.currency,
          state.referenceExternalTransactionId ?? null, state.referenceTransactionId ?? null, state.status,
          state.failureCode ?? null, String(walletRow.balance), now, now, now],
      );

      return {
        transactionId: state.id,
        status: state.status,
        balance: { amount: String(walletRow.balance), currency: walletRow.currency },
        idempotentReplay: false,
        failureCode: state.failureCode,
      };
    });

    this.recordResult(result, startedAt);
    return result;
  }

  async execute(input: ProcessWagerInput): Promise<ProcessWagerResult> {
    const startedAt = performance.now();
    const money = Money.from(input.money);
    if (!money.isPositive()) throw new Error('Transaction amount must be greater than zero');
    if (input.kind === WagerTransactionKind.Opening) throw new Error('OPENING is an internal transaction');
    const { inboxMessage, ...wagerInput } = input;
    const wager = WagerTransaction.create({ ...wagerInput, money });
    let resolvedPendingStatuses: WagerTransactionStatus[] = [];

    try {
      const result = await this.em.transactional(async (tx) => {
        const execute = <T = any[]>(query: string, params: unknown[] = []) => executeInTransaction<T>(tx, query, params);
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

        let reference: ReferenceRow | undefined;
        if (!wager.isTerminal() && wager.requiresReference()) {
          const references = await execute<ReferenceRow[]>(
            `select id, provider_id as "providerId", external_transaction_id as "externalTransactionId",
                    player_id as "playerId", wallet_id as "walletId", round_id as "roundId", kind,
                    amount::text, currency, status
             from wager_transaction where provider_id = ? and external_transaction_id = ?`,
            [wager.providerId, wager.referenceExternalTransactionId],
          );
          reference = references[0];
          if (!reference) {
            wager.markPendingReference();
          } else {
            const referenceFailure = this.referenceFailure(wager, reference);
            if (referenceFailure) {
              wager.reject(referenceFailure);
            } else {
              const [reversal] = await execute<any[]>(
                `select id from wager_transaction
                 where reference_transaction_id = ? and kind = ? and status = 'PROCESSED'`,
                [reference.id, wager.kind],
              );
              if (reversal) wager.reject(FailureCode.REFERENCE_ALREADY_REVERSED);
            }
          }
        }

        const now = new Date();
        let ledger: WalletLedgerEntry | undefined;
        if (!wager.isTerminal() && wager.status !== WagerTransactionStatus.PendingReference && wager.affectsBalance()) {
          const before = wallet.balance;
          try {
            const direction = this.directionFor(wager, reference);
            if (direction === LedgerDirection.Debit) wallet.debit(money);
            else wallet.credit(money);
            ledger = WalletLedgerEntry.create({
              walletId: wallet.id, transactionId: wager.id, direction,
              money, balanceBefore: before, balanceAfter: wallet.balance, walletVersion: wallet.version,
            });
          } catch (error) {
            if (!(error instanceof InsufficientBalanceError) && !(error instanceof CurrencyMismatchError)) throw error;
            wager.reject(wager.requiresReference()
              ? FailureCode.REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE
              : error.code);
          }
        }
        if (!wager.isTerminal() && wager.status !== WagerTransactionStatus.PendingReference) {
          wager.markProcessed(reference?.id);
        }

        const state = wager.toState();
        await execute(
          `insert into wager_transaction (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, failure_code, resulting_balance, processed_at, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [state.id, state.providerId, state.externalTransactionId, state.idempotencyKey, state.payloadHash, state.walletId,
            state.playerId, state.roundId, state.gameId, state.kind, state.money, state.currency,
            state.referenceExternalTransactionId ?? null, state.referenceTransactionId ?? null, state.status, state.failureCode ?? null, wallet.balance.getAmount(),
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
        const transactionEvent = wager.status === WagerTransactionStatus.PendingReference
          ? WagerTransactionPendingReferenceEvent.from({ aggregateId: wager.id, correlationId, data: {
              transactionId: wager.id, externalTransactionId: wager.externalTransactionId,
              providerId: wager.providerId, playerId: wager.playerId, walletId: wager.walletId,
              roundId: wager.roundId, referenceExternalTransactionId: wager.referenceExternalTransactionId!,
            } })
          : wager.status === WagerTransactionStatus.Rejected
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

        if (wager.status === WagerTransactionStatus.Processed) {
          resolvedPendingStatuses = await this.resolvePendingForReference(execute, wallet, wager, now);
        }

        return { transactionId: wager.id, status: wager.status, balance: wallet.balance.toJSON(), idempotentReplay: false, failureCode: wager.failureCode };
      });
      this.recordResult(result, startedAt);
      for (const status of resolvedPendingStatuses) this.metrics.recordTransaction(status);
      return result;
    } catch (error) {
      if (error instanceof IdempotencyConflictError) this.metrics.recordIdempotencyConflict();
      this.metrics.observeWagerDuration((performance.now() - startedAt) / 1000);
      // A duplicate key can race on different wallets. The database unique
      // constraint arbitrates; after rollback, load and compare the winner.
      const wrappedError = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
      const databaseError = wrappedError.cause ?? wrappedError;
      if (['55P03', '40P01', '40001'].includes(databaseError.code ?? '')) {
        this.metrics.recordLockConflict(databaseError.code!);
      }
      if (databaseError.code === '23505' && databaseError.constraint === 'wager_reference_reversal_uq') {
        throw new ReferenceAlreadyReversedError(wager.referenceExternalTransactionId ?? 'unknown');
      }
      if (databaseError.code === '23505') {
        const existing = await this.em.getConnection().execute<any[]>(
          'select id, payload_hash as "payloadHash", status, failure_code as "failureCode", resulting_balance::text as "resultingBalance", currency from wager_transaction where provider_id = ? and idempotency_key = ?',
          [input.providerId, input.idempotencyKey],
        );
        if (existing[0]) {
          if (existing[0].payloadHash !== wager.payloadHash) {
            this.metrics.recordIdempotencyConflict();
            throw new IdempotencyConflictError(input.idempotencyKey);
          }
          const replay = { transactionId: existing[0].id, status: existing[0].status, balance: { amount: String(existing[0].resultingBalance), currency: existing[0].currency }, idempotentReplay: true, failureCode: existing[0].failureCode ?? undefined };
          this.recordResult(replay, startedAt);
          return replay;
        }
      }
      throw error;
    }
  }

  private recordResult(result: ProcessWagerResult, startedAt: number): void {
    if (result.idempotentReplay) this.metrics.recordIdempotencyReplay();
    else this.metrics.recordTransaction(result.status);
    this.metrics.observeWagerDuration((performance.now() - startedAt) / 1000);
  }

  private referenceFailure(wager: WagerTransaction, reference: ReferenceRow): string | undefined {
    if (reference.status !== WagerTransactionStatus.Processed) return FailureCode.REFERENCE_NOT_PROCESSED;
    if (reference.providerId !== wager.providerId) return FailureCode.REFERENCE_PROVIDER_MISMATCH;
    if (reference.playerId !== wager.playerId) return FailureCode.REFERENCE_PLAYER_MISMATCH;
    if (reference.walletId !== wager.walletId) return FailureCode.REFERENCE_WALLET_MISMATCH;
    if (reference.currency !== wager.money.currency) return FailureCode.REFERENCE_CURRENCY_MISMATCH;
    if (reference.roundId !== wager.roundId) return FailureCode.REFERENCE_ROUND_MISMATCH;
    if (reference.amount !== wager.money.getAmount()) return FailureCode.REFERENCE_AMOUNT_MISMATCH;
    if (wager.kind === WagerTransactionKind.Refund && reference.kind !== WagerTransactionKind.Bet) {
      return FailureCode.INVALID_REFERENCE_TYPE;
    }
    if (wager.kind === WagerTransactionKind.Rollback &&
        reference.kind !== WagerTransactionKind.Bet &&
        reference.kind !== WagerTransactionKind.Win &&
        reference.kind !== WagerTransactionKind.Refund) {
      return FailureCode.INVALID_REFERENCE_TYPE;
    }
    return undefined;
  }

  private directionFor(wager: WagerTransaction, reference?: ReferenceRow): LedgerDirection {
    if (wager.kind === WagerTransactionKind.Rollback) {
      if (!reference) throw new Error('A valid reference is required to determine rollback direction');
      return reference.kind === WagerTransactionKind.Bet ? LedgerDirection.Credit : LedgerDirection.Debit;
    }
    return wager.ledgerDirectionFor();
  }

  /** Rechecks a persisted pending reversal after a scheduled reference lookup. */
  async resolvePendingReference(referenceId: string): Promise<void> {
    const statuses = await this.em.transactional(async (tx): Promise<WagerTransactionStatus[]> => {
      const execute = <T = any[]>(query: string, params: unknown[] = []) => executeInTransaction<T>(tx, query, params);
      const [candidate] = await execute<any[]>(
        `select wallet_id as "walletId" from wager_transaction where id = ?`,
        [referenceId],
      );
      if (!candidate) return [];
      const [walletRow] = await execute<any[]>(
        `select id, player_id as "playerId", currency, balance::text, version,
                created_at as "createdAt", updated_at as "updatedAt"
         from wallet where id = ? for update`,
        [candidate.walletId],
      );
      if (!walletRow) return [];
      const [referenceRow] = await execute<any[]>(
        `select id, provider_id as "providerId", external_transaction_id as "externalTransactionId",
                player_id as "playerId", wallet_id as "walletId", round_id as "roundId", game_id as "gameId",
                kind, amount::text as amount, currency, status, idempotency_key as "idempotencyKey",
                payload_hash as "payloadHash", created_at as "createdAt", updated_at as "updatedAt"
         from wager_transaction where id = ? for update`,
        [referenceId],
      );
      if (!referenceRow) return [];
      const wallet = Wallet.rehydrate({
        id: walletRow.id, playerId: walletRow.playerId, currency: walletRow.currency,
        balance: String(walletRow.balance), version: walletRow.version,
        createdAt: new Date(walletRow.createdAt), updatedAt: new Date(walletRow.updatedAt),
      });
      const reference = WagerTransaction.rehydrate({
        id: referenceRow.id, providerId: referenceRow.providerId,
        externalTransactionId: referenceRow.externalTransactionId, playerId: referenceRow.playerId,
        walletId: referenceRow.walletId, roundId: referenceRow.roundId, gameId: referenceRow.gameId,
        kind: referenceRow.kind, money: String(referenceRow.amount), currency: referenceRow.currency,
        status: referenceRow.status, idempotencyKey: referenceRow.idempotencyKey,
        payloadHash: referenceRow.payloadHash, createdAt: new Date(referenceRow.createdAt),
        updatedAt: new Date(referenceRow.updatedAt),
      });
      return this.resolvePendingForReference(execute, wallet, reference, new Date());
    });
    for (const status of statuses) this.metrics.recordTransaction(status);
  }

  private async resolvePendingForReference(
    execute: SqlExecutor,
    wallet: Wallet,
    referenceWager: WagerTransaction,
    now: Date,
  ): Promise<WagerTransactionStatus[]> {
    const pendingRows = await execute<PendingWagerRow[]>(
      `select id, external_transaction_id as "externalTransactionId", provider_id as "providerId",
              player_id as "playerId", wallet_id as "walletId", round_id as "roundId", game_id as "gameId",
              kind, amount::text as money, currency, status, reference_external_transaction_id as "referenceExternalTransactionId",
              reference_transaction_id as "referenceTransactionId", idempotency_key as "idempotencyKey",
              payload_hash as "payloadHash", failure_code as "failureCode", created_at as "createdAt", updated_at as "updatedAt"
       from wager_transaction
       where provider_id = ? and reference_external_transaction_id = ? and status = 'PENDING_REFERENCE'
       order by created_at, id for update`,
      [referenceWager.providerId, referenceWager.externalTransactionId],
    );
    if (pendingRows.length === 0) return [];

    const reference: ReferenceRow = {
      id: referenceWager.id,
      providerId: referenceWager.providerId,
      externalTransactionId: referenceWager.externalTransactionId,
      playerId: referenceWager.playerId,
      walletId: referenceWager.walletId,
      roundId: referenceWager.roundId,
      kind: referenceWager.kind,
      amount: referenceWager.money.getAmount(),
      currency: referenceWager.money.currency,
      status: referenceWager.status,
    };

    const resolvedStatuses: WagerTransactionStatus[] = [];
    for (const row of pendingRows) {
      const pending = WagerTransaction.rehydrate({
        ...row,
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
      });
      let ledger: WalletLedgerEntry | undefined;
      const failure = this.referenceFailure(pending, reference);
      if (failure) {
        pending.reject(failure);
      } else {
        const [previousReversal] = await execute<any[]>(
          `select id from wager_transaction
           where reference_transaction_id = ? and kind = ? and status = 'PROCESSED'`,
          [reference.id, pending.kind],
        );
        if (previousReversal) {
          pending.reject(FailureCode.REFERENCE_ALREADY_REVERSED);
        } else {
          const before = wallet.balance;
          const direction = this.directionFor(pending, reference);
          try {
            if (direction === LedgerDirection.Debit) wallet.debit(pending.money);
            else wallet.credit(pending.money);
            ledger = WalletLedgerEntry.create({
              walletId: wallet.id, transactionId: pending.id, direction, money: pending.money,
              balanceBefore: before, balanceAfter: wallet.balance, walletVersion: wallet.version,
            });
            pending.markProcessed(reference.id);
          } catch (error) {
            if (!(error instanceof InsufficientBalanceError) && !(error instanceof CurrencyMismatchError)) throw error;
            pending.reject(FailureCode.REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE);
          }
        }
      }

      const state = pending.toState();
      await execute(
        `update wager_transaction set status = ?, failure_code = ?, reference_transaction_id = ?,
           resulting_balance = ?, processed_at = ?, updated_at = ? where id = ?`,
        [state.status, state.failureCode ?? null, state.referenceTransactionId ?? null, wallet.balance.getAmount(),
          state.status === WagerTransactionStatus.Processed || state.status === WagerTransactionStatus.Rejected ? now : null,
          now, state.id],
      );
      if (ledger) {
        const entry = ledger.toState();
        await execute('update wallet set balance = ?, version = ?, updated_at = ? where id = ?',
          [wallet.balance.getAmount(), wallet.version, wallet.updatedAt, wallet.id]);
        await execute(
          `insert into wallet_ledger_entry (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [entry.id, entry.walletId, entry.transactionId, entry.direction, entry.money, entry.currency,
            entry.balanceBefore, entry.balanceAfter, entry.walletVersion, entry.createdAt],
        );
      }

      const correlationId = pending.id;
      const events = [pending.status === WagerTransactionStatus.Rejected
        ? WagerTransactionRejectedEvent.from({ aggregateId: pending.id, correlationId, data: {
            transactionId: pending.id, externalTransactionId: pending.externalTransactionId,
            providerId: pending.providerId, playerId: pending.playerId, walletId: pending.walletId,
            roundId: pending.roundId, gameId: pending.gameId, kind: pending.kind,
            money: pending.money.toJSON(), failureCode: pending.failureCode ?? 'REFERENCE_REJECTED',
          } }).toJSON()
        : WagerTransactionProcessedEvent.from({ aggregateId: pending.id, correlationId, causationId: reference.id, data: {
            transactionId: pending.id, externalTransactionId: pending.externalTransactionId,
            providerId: pending.providerId, playerId: pending.playerId, walletId: pending.walletId,
            roundId: pending.roundId, gameId: pending.gameId, kind: pending.kind,
            money: pending.money.toJSON(), status: pending.status,
            walletBalance: wallet.balance.toJSON(), walletVersion: wallet.version,
          } }).toJSON()];
      if (ledger) events.push(WalletBalanceChangedEvent.from({ aggregateId: wallet.id, correlationId, causationId: pending.id, data: {
        walletId: wallet.id, transactionId: pending.id, direction: ledger.direction, money: pending.money.toJSON(),
        balanceBefore: ledger.balanceBefore.toJSON(), balanceAfter: ledger.balanceAfter.toJSON(), walletVersion: wallet.version,
      } }).toJSON());
      for (const event of events) {
        await execute(
          'insert into outbox_message (id, event_id, event_type, aggregate_id, payload, occurred_at, attempts, created_at) values (?, ?, ?, ?, ?::jsonb, ?, 0, ?)',
          [uuidv7(), event.eventId, event.eventType, event.aggregateId, JSON.stringify(event), event.occurredAt, now],
        );
      }
      resolvedStatuses.push(pending.status);
    }
    return resolvedStatuses;
  }
}
