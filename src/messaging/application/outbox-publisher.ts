import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { EntityManager } from '@mikro-orm/postgresql';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { executeInTransaction } from '../../database/execute-in-transaction.js';
import { AppMetrics } from '../../observability/app-metrics.js';

interface ClaimedOutboxMessage {
  id: string;
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  payload: unknown;
  attempts: number;
}

const LEASE_SECONDS = 60;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

/** Publishes committed outbox rows; multiple instances coordinate through PostgreSQL row locks. */
@Injectable()
export class OutboxPublisher {
  private running = false;
  private readonly queueUrl = process.env.SQS_OUTBOX_QUEUE_URL;

  constructor(private readonly em: EntityManager, private readonly sqs: SQSClient, private readonly metrics: AppMetrics) {}

  @Interval(Number(process.env.OUTBOX_POLL_INTERVAL_MS) || 1000)
  async publishPending(): Promise<void> {
    if (this.running || !this.queueUrl) return;
    this.running = true;
    try {
      const batchSize = Math.min(Math.max(Number(process.env.OUTBOX_BATCH_SIZE) || 10, 1), 100);
      await this.refreshLag();
      const claimed = await this.claim(batchSize);
      for (const message of claimed) await this.publishOne(message);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'outbox_poll_failed', error: this.errorMessage(error) }));
    } finally {
      this.running = false;
    }
  }

  private async refreshLag(): Promise<void> {
    const rows = await this.em.getConnection().execute<any[]>(
      `select coalesce(extract(epoch from (now() - min(created_at))), 0)::float8 as seconds
       from outbox_message where published_at is null`,
    );
    this.metrics.setOutboxLag(Number(rows[0]?.seconds ?? 0));
  }

  private async claim(batchSize: number): Promise<ClaimedOutboxMessage[]> {
    return this.em.transactional(async (tx) => executeInTransaction<ClaimedOutboxMessage[]>(
      tx,
      `with candidates as (
         select id from outbox_message
         where published_at is null and (locked_until is null or locked_until <= now())
           and not exists (
             select 1 from outbox_message as earlier
             where earlier.aggregate_id = outbox_message.aggregate_id
               and earlier.published_at is null
               and (earlier.created_at, earlier.id) < (outbox_message.created_at, outbox_message.id)
           )
         order by created_at asc, id asc
         for update skip locked
         limit ?
       )
       update outbox_message as outbox
       set locked_until = now() + (? * interval '1 second'), attempts = attempts + 1
       from candidates
       where outbox.id = candidates.id
       returning outbox.id, outbox.event_id as "eventId", outbox.event_type as "eventType",
                 outbox.aggregate_id as "aggregateId", outbox.payload, outbox.attempts,
                 outbox.payload->>'correlationId' as "correlationId",
                 outbox.payload->'data'->>'transactionId' as "transactionId",
                 outbox.payload->'data'->>'walletId' as "walletId",
                 outbox.payload->'data'->>'providerId' as "providerId"`,
      [batchSize, LEASE_SECONDS],
    ));
  }

  private async publishOne(message: ClaimedOutboxMessage): Promise<void> {
    try {
      const body = typeof message.payload === 'string' ? message.payload : JSON.stringify(message.payload);
      await this.sqs.send(new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: body,
        MessageGroupId: message.aggregateId,
        // FIFO deduplication reduces duplicates; the database inbox remains the durable guarantee.
        MessageDeduplicationId: message.eventId,
      }));
      await this.em.transactional((tx) => executeInTransaction(
        tx,
        'update outbox_message set published_at = now(), locked_until = null where id = ? and published_at is null',
        [message.id],
      ));
      console.log(JSON.stringify({ level: 'info', event: 'outbox_published', eventId: message.eventId, eventType: message.eventType, aggregateId: message.aggregateId, correlationId: message.correlationId, transactionId: message.transactionId, walletId: message.walletId, providerId: message.providerId }));
    } catch (error) {
      this.metrics.recordRetry('outbox');
      const backoffMs = Math.min(1000 * (2 ** Math.max(message.attempts - 1, 0)), MAX_BACKOFF_MS);
      await this.em.transactional((tx) => executeInTransaction(
        tx,
        `update outbox_message
         set locked_until = now() + (? * interval '1 millisecond')
         where id = ? and published_at is null`,
        [backoffMs, message.id],
      ));
      console.error(JSON.stringify({ level: 'error', event: 'outbox_publish_failed', eventId: message.eventId, eventType: message.eventType, aggregateId: message.aggregateId, correlationId: message.correlationId, transactionId: message.transactionId, walletId: message.walletId, providerId: message.providerId, error: this.errorMessage(error) }));
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
