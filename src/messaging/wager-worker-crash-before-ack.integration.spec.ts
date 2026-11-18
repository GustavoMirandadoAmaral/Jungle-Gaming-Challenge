import { expect, test } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { spawnSync } from 'node:child_process';
import { v7 as uuidv7 } from 'uuid';
import mikroOrmConfig from '../mikro-orm.config.js';
import { AppMetrics } from '../observability/app-metrics.js';
import { ProcessWagerTransaction } from '../wagering/application/process-wager-transaction.js';
import { waitForApps } from '../test-utils/wait-for-apps.js';
import { WagerSqsConsumer } from './application/wager-sqs-consumer.js';

const appUrl = process.env.TEST_APP_URL ?? 'http://localhost:3001';
const sqsOptions = {
  endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
  region: process.env.SQS_REGION ?? 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
};

test('a worker process killed after commit leaves SQS for redelivery without applying a second debit', async () => {
  await waitForApps([appUrl]);
  const sqs = new SQSClient(sqsOptions);
  const orm = await MikroORM.init(mikroOrmConfig);
  const queueName = `worker-crash-before-ack-${uuidv7()}.fifo`;
  let queueUrl: string | undefined;

  try {
    const queue = await sqs.send(new CreateQueueCommand({
      QueueName: queueName,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }));
    queueUrl = queue.QueueUrl;
    expect(queueUrl).toBeTruthy();

    const playerId = uuidv7();
    const walletResponse = await fetch(`${appUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }),
    });
    expect(walletResponse.status).toBe(201);
    const wallet = await walletResponse.json() as { id: string };

    const externalTransactionId = `worker-crash-${uuidv7()}`;
    const message = await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        messageId: uuidv7(),
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          providerId: 'worker-crash-test',
          externalTransactionId,
          idempotencyKey: `worker-crash-test:${externalTransactionId}`,
          playerId,
          walletId: wallet.id,
          roundId: `round-${externalTransactionId}`,
          gameId: 'worker-crash-test',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        },
      }),
      MessageGroupId: wallet.id,
      MessageDeduplicationId: uuidv7(),
    }));
    expect(message.MessageId).toBeTruthy();

    const child = spawnSync(process.execPath, ['run', 'src/messaging/test-workers/crash-wager-consumer-before-ack.ts'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        SQS_ENDPOINT: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
        SQS_WAGER_VISIBILITY_TIMEOUT_SECONDS: '1',
        TEST_WAGER_QUEUE_URL: queueUrl,
        TEST_SQS_MESSAGE_ID: message.MessageId,
      },
    });
    expect(child.status).toBe(137);
    expect(child.stdout).toContain(`simulating worker process death after commit and before SQS ack for ${message.MessageId}`);

    const afterCrash = await fetch(`${appUrl}/wallets/${wallet.id}`).then((response) => response.json()) as {
      balance: { amount: string }; version: number;
    };
    expect(afterCrash.balance.amount).toBe('90.00');
    expect(afterCrash.version).toBe(2);

    const inboxBeforeRedelivery = await orm.em.getConnection().execute<any[]>(
      `select count(*)::int as count from inbox_message
       where consumer_name = 'wager-transaction-consumer-v1' and message_id = ?`,
      [message.MessageId],
    );
    expect(Number(inboxBeforeRedelivery[0].count)).toBe(1);

    // The child asked SQS for a one-second visibility timeout; let the actual
    // message become visible and process it with a fresh consumer process.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const metrics = new AppMetrics();
    const retryConsumer = new WagerSqsConsumer(
      sqs,
      new ProcessWagerTransaction(orm.em.fork(), metrics),
      metrics,
      queueUrl,
      undefined,
      1,
    );
    await retryConsumer.poll();

    const finalWallet = await fetch(`${appUrl}/wallets/${wallet.id}`).then((response) => response.json()) as {
      balance: { amount: string }; version: number;
    };
    expect(finalWallet.balance.amount).toBe('90.00');
    expect(finalWallet.version).toBe(2);

    const ledger = await fetch(`${appUrl}/wallets/${wallet.id}/ledger`).then((response) => response.json()) as {
      items: Array<{ direction: string; money: { amount: string } }>;
    };
    expect(ledger.items.filter((entry) => entry.direction === 'DEBIT' && entry.money.amount === '10.00')).toHaveLength(1);

    const inboxAfterRedelivery = await orm.em.getConnection().execute<any[]>(
      `select count(*)::int as count from inbox_message
       where consumer_name = 'wager-transaction-consumer-v1' and message_id = ?`,
      [message.MessageId],
    );
    expect(Number(inboxAfterRedelivery[0].count)).toBe(1);
    const queueAttributes = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }));
    expect(Number(queueAttributes.Attributes?.ApproximateNumberOfMessages ?? 0)).toBe(0);
    expect(Number(queueAttributes.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)).toBe(0);
  } finally {
    await orm.close(true);
    if (queueUrl) await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    await sqs.destroy();
  }
}, 30_000);
