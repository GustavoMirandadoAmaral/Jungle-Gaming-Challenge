import { expect, test } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { spawnSync } from 'node:child_process';
import { v7 as uuidv7 } from 'uuid';
import mikroOrmConfig from '../mikro-orm.config.js';
import { AppMetrics } from '../observability/app-metrics.js';
import { waitForApps } from '../test-utils/wait-for-apps.js';
import { OutboxPublisher } from './application/outbox-publisher.js';

const appUrls = [3001, 3002, 3003].map((port) => `http://localhost:${port}`);
const appServices = ['app-1', 'app-2', 'app-3'];
const sqsOptions = {
  endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
  region: process.env.SQS_REGION ?? 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
};

function compose(args: string[]) {
  return spawnSync('docker', ['compose', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 30_000,
  });
}

test('two publishers concurrently claim disjoint outbox rows and publish each event once', async () => {
  await waitForApps(appUrls);
  const orm = await MikroORM.init(mikroOrmConfig);
  const queueAdmin = new SQSClient(sqsOptions);
  const queueName = `concurrent-publishers-${uuidv7()}.fifo`;
  let queueUrl: string | undefined;
  let appsNeedRestart = false;
  let releaseFirstSend: () => void = () => {};

  try {
    const idleDeadline = Date.now() + 20_000;
    let pendingCount = 1;
    while (Date.now() < idleDeadline && pendingCount > 0) {
      const rows = await orm.em.getConnection().execute<any[]>(
        'select count(*)::int as count from outbox_message where published_at is null',
      );
      pendingCount = Number(rows[0].count);
      if (pendingCount > 0) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(pendingCount).toBe(0);

    // Temporarily stop the scheduled Compose publishers so the two publisher
    // instances below are the only claimers of these test rows.
    appsNeedRestart = true;
    const stopped = compose(['stop', ...appServices]);
    expect(stopped.status).toBe(0);

    const createdQueue = await queueAdmin.send(new CreateQueueCommand({
      QueueName: queueName,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }));
    queueUrl = createdQueue.QueueUrl;
    expect(queueUrl).toBeTruthy();

    const correlationId = uuidv7();
    const expectedEventIds = Array.from({ length: 20 }, () => uuidv7());
    const eventRows = expectedEventIds.map((eventId) => {
      const aggregateId = uuidv7();
      const payload = {
        eventId,
        eventType: 'WagerTransactionProcessed',
        aggregateId,
        correlationId,
        occurredAt: new Date().toISOString(),
        version: 1,
        data: { transactionId: uuidv7(), walletId: uuidv7(), status: 'PROCESSED' },
      };
      return { id: uuidv7(), eventId, aggregateId, payload };
    });
    await orm.em.transactional(async (tx) => {
      for (const row of eventRows) {
        await tx.getConnection().execute(
          `insert into outbox_message (id, event_id, event_type, aggregate_id, payload, occurred_at)
           values (?, ?, ?, ?, ?::jsonb, now())`,
          [row.id, row.eventId, row.payload.eventType, row.aggregateId, JSON.stringify(row.payload)],
          'all',
          tx.getTransactionContext(),
        );
      }
    });

    let firstSendStartedResolve!: () => void;
    const firstSendStarted = new Promise<void>((resolve) => { firstSendStartedResolve = resolve; });
    const firstSendGate = new Promise<void>((resolve) => { releaseFirstSend = resolve; });
    let firstSendPaused = false;
    const sqsA = new SQSClient(sqsOptions);
    const sqsB = new SQSClient(sqsOptions);
    sqsA.middlewareStack.add(
      (next) => async (args) => {
        const input = args.input as { QueueUrl?: string };
        if (!firstSendPaused && input.QueueUrl === queueUrl) {
          firstSendPaused = true;
          firstSendStartedResolve();
          await firstSendGate;
        }
        return next(args);
      },
      { step: 'initialize', name: 'holdFirstRealSqsSend', priority: 'high' },
    );

    try {
      const publisherA = new OutboxPublisher(orm.em.fork(), sqsA, new AppMetrics(), queueUrl);
      const publisherB = new OutboxPublisher(orm.em.fork(), sqsB, new AppMetrics(), queueUrl);
      const publisherAPromise = publisherA.publishPending();
      let firstSendTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          firstSendStarted,
          new Promise<never>((_, reject) => {
            firstSendTimeout = setTimeout(() => reject(new Error('Publisher A did not reach SQS')), 15_000);
          }),
        ]);
      } finally {
        if (firstSendTimeout) clearTimeout(firstSendTimeout);
      }

      // Publisher A already committed its claim and is paused at the real SQS
      // send. Publisher B must claim the remaining rows instead of those leases.
      await publisherB.publishPending();
      releaseFirstSend();
      await publisherAPromise;

      const rows = await orm.em.getConnection().execute<any[]>(
        `select count(*)::int as total,
                count(published_at)::int as published,
                count(*) filter (where attempts = 1)::int as claimed_once
         from outbox_message where payload->>'correlationId' = ?`,
        [correlationId],
      );
      expect(Number(rows[0].total)).toBe(expectedEventIds.length);
      expect(Number(rows[0].published)).toBe(expectedEventIds.length);
      expect(Number(rows[0].claimed_once)).toBe(expectedEventIds.length);

      const received: Array<{ body: string; receiptHandle: string }> = [];
      const receiveDeadline = Date.now() + 15_000;
      while (Date.now() < receiveDeadline && received.length < expectedEventIds.length) {
        const response = await queueAdmin.send(new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          VisibilityTimeout: 10,
        }));
        for (const message of response.Messages ?? []) {
          if (message.Body && message.ReceiptHandle) received.push({ body: message.Body, receiptHandle: message.ReceiptHandle });
        }
      }
      const receivedEventIds = received.map(({ body }) => (JSON.parse(body) as { eventId: string }).eventId);
      expect(receivedEventIds).toHaveLength(expectedEventIds.length);
      expect(new Set(receivedEventIds).size).toBe(expectedEventIds.length);
      expect(receivedEventIds.sort()).toEqual(expectedEventIds.sort());
      for (const message of received) {
        await queueAdmin.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.receiptHandle }));
      }
    } finally {
      releaseFirstSend();
      await Promise.all([sqsA.destroy(), sqsB.destroy()]);
    }
  } finally {
    if (queueUrl) await queueAdmin.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    await queueAdmin.destroy();
    if (appsNeedRestart) {
      const started = compose(['start', ...appServices]);
      if (started.status !== 0) console.error(started.stderr || started.stdout || 'Failed to restart app services');
      await waitForApps(appUrls);
    }
    await orm.close(true);
  }
}, 60_000);
