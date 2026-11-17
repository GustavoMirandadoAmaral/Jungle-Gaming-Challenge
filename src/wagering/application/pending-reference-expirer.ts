import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { EntityManager } from '@mikro-orm/postgresql';
import { v7 as uuidv7 } from 'uuid';
import { executeInTransaction } from '../../database/execute-in-transaction.js';
import { WagerTransactionRejectedEvent } from '../../shared/domain/events/wager-transaction-rejected.event.js';
import { Money } from '../../shared/domain/value-objects/money.js';
import { WagerTransactionKind } from '../domain/enums/wager-transaction-kind.enum.js';
import { WagerTransactionStatus } from '../domain/enums/wager-transaction-status.enum.js';
import { ProcessWagerTransaction } from './process-wager-transaction.js';
import { AppMetrics } from '../../observability/app-metrics.js';

interface PendingReferenceRow {
  id: string; externalTransactionId: string; providerId: string; playerId: string; walletId: string;
  roundId: string; gameId: string; kind: WagerTransactionKind; amount: string; currency: string;
  referenceExternalTransactionId: string; attempts: number; createdAt: Date;
}

interface DueReferenceResult {
  rejectedCount: number;
  referenceIds: string[];
  retryCount: number;
}

@Injectable()
export class PendingReferenceExpirer {
  private running = false;

  constructor(
    private readonly em: EntityManager,
    private readonly processWager: ProcessWagerTransaction,
    private readonly metrics: AppMetrics,
  ) {}

  @Interval(Number(process.env.PENDING_REFERENCE_POLL_INTERVAL_MS) || 5000)
  async retry(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const maxAttempts = Math.max(Number(process.env.PENDING_REFERENCE_MAX_ATTEMPTS) || 10, 1);
      const ttlMinutes = Math.max(Number(process.env.PENDING_REFERENCE_TTL_MINUTES) || 60, 1);
      const baseBackoffMs = Math.max(Number(process.env.PENDING_REFERENCE_BACKOFF_BASE_MS) || 1000, 100);
      const maxBackoffMs = Math.max(Number(process.env.PENDING_REFERENCE_BACKOFF_MAX_MS) || 60_000, baseBackoffMs);
      const outcome = await this.em.transactional(async (tx): Promise<DueReferenceResult> => {
        const execute = <T = any[]>(query: string, params: unknown[] = []) => executeInTransaction<T>(tx, query, params);
        const candidates = await execute<PendingReferenceRow[]>(
          `select id, external_transaction_id as "externalTransactionId", provider_id as "providerId",
                  player_id as "playerId", wallet_id as "walletId", round_id as "roundId", game_id as "gameId",
                  kind, amount::text as amount, currency,
                  reference_external_transaction_id as "referenceExternalTransactionId",
                  pending_reference_attempts as attempts, created_at as "createdAt"
           from wager_transaction
           where status = 'PENDING_REFERENCE' and pending_reference_next_attempt_at <= now()
           order by pending_reference_next_attempt_at, created_at, id
           for update skip locked limit 100`,
        );
        const referenceIds: string[] = [];
        const rejected: PendingReferenceRow[] = [];
        let retryCount = 0;
        const now = Date.now();

        for (const row of candidates) {
          const attempts = row.attempts + 1;
          const references = await execute<any[]>(
            `select id from wager_transaction where provider_id = ? and external_transaction_id = ?`,
            [row.providerId, row.referenceExternalTransactionId],
          );
          if (references[0]) {
            retryCount += 1;
            referenceIds.push(references[0].id);
            const backoff = Math.min(baseBackoffMs * 2 ** Math.min(attempts - 1, 20), maxBackoffMs);
            await execute(
              `update wager_transaction set pending_reference_attempts = ?,
                 pending_reference_next_attempt_at = ? where id = ?`,
              [attempts, new Date(now + backoff), row.id],
            );
            continue;
          }

          const expiredByTtl = new Date(row.createdAt).getTime() <= now - ttlMinutes * 60_000;
          if (attempts >= maxAttempts || expiredByTtl) {
            await execute(
              `update wager_transaction set status = ?, failure_code = ?, pending_reference_attempts = ?,
                 processed_at = now(), updated_at = now() where id = ?`,
              [WagerTransactionStatus.Rejected, 'REFERENCE_NOT_FOUND', attempts, row.id],
            );
            rejected.push(row);
            continue;
          }

          const backoff = Math.min(baseBackoffMs * 2 ** Math.min(attempts - 1, 20), maxBackoffMs);
          retryCount += 1;
          await execute(
            `update wager_transaction set pending_reference_attempts = ?,
               pending_reference_next_attempt_at = ? where id = ?`,
            [attempts, new Date(now + backoff), row.id],
          );
        }

        for (const row of rejected) {
          const event = WagerTransactionRejectedEvent.from({ aggregateId: row.id, correlationId: row.id, data: {
            transactionId: row.id, externalTransactionId: row.externalTransactionId, providerId: row.providerId,
            playerId: row.playerId, walletId: row.walletId, roundId: row.roundId, gameId: row.gameId,
            kind: row.kind, money: Money.from({ amount: row.amount, currency: row.currency }).toJSON(),
            failureCode: 'REFERENCE_NOT_FOUND',
          } }).toJSON();
          await execute(
            'insert into outbox_message (id, event_id, event_type, aggregate_id, payload, occurred_at, attempts, created_at) values (?, ?, ?, ?, ?::jsonb, ?, 0, now())',
            [uuidv7(), event.eventId, event.eventType, event.aggregateId, JSON.stringify(event), event.occurredAt],
          );
        }
        return { rejectedCount: rejected.length, referenceIds, retryCount };
      });

      // The shared use case resolves pending rows under the wallet lock and
      // writes balance, ledger, transaction status, and outbox atomically.
      for (const referenceId of outcome.referenceIds) {
        await this.processWager.resolvePendingReference(referenceId);
      }
      for (let attempt = 0; attempt < outcome.retryCount; attempt += 1) this.metrics.recordRetry('pending_reference');
      for (let rejection = 0; rejection < outcome.rejectedCount; rejection += 1) this.metrics.recordTransaction('REJECTED');
      if (outcome.rejectedCount > 0) {
        console.log(JSON.stringify({ level: 'info', event: 'pending_references_rejected', count: outcome.rejectedCount }));
      }
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'pending_reference_retry_failed', error: error instanceof Error ? error.message : String(error) }));
    } finally {
      this.running = false;
    }
  }
}
