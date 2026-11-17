import { expect, test } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { v7 as uuidv7 } from 'uuid';
import mikroOrmConfig from '../mikro-orm.config.js';
import { AppMetrics } from '../observability/app-metrics.js';
import { WagerSqsConsumer } from './application/wager-sqs-consumer.js';
import { ProcessWagerTransaction } from '../wagering/application/process-wager-transaction.js';
import { waitForApps } from '../test-utils/wait-for-apps.js';

const appUrl = process.env.TEST_APP_URL ?? 'http://localhost:3001';
const sqsOptions = {
  endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
  region: process.env.SQS_REGION ?? 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
};

test('a lost SQS ack after the database commit redelivers without applying a second debit', async () => {
  await waitForApps([appUrl]);
  const sqs = new SQSClient(sqsOptions);
  const orm = await MikroORM.init(mikroOrmConfig);
  const queueName = `commit-before-ack-${uuidv7()}.fifo`;
  let queueUrl: string | undefined;
  let faultingSqs: SQSClient | undefined;
  let faultInjected = false;

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

    const externalTransactionId = `ack-window-${uuidv7()}`;
    const messageId = uuidv7();
    const envelope = {
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'commit-before-ack-test',
        externalTransactionId,
        idempotencyKey: `commit-before-ack-test:${externalTransactionId}`,
        playerId,
        walletId: wallet.id,
        roundId: `round-${externalTransactionId}`,
        gameId: 'commit-before-ack-test',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      },
    };
    const sentMessage = await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(envelope),
      MessageGroupId: wallet.id,
      MessageDeduplicationId: messageId,
    }));
    expect(sentMessage.MessageId).toBeTruthy();

    // Forward every SQS operation to LocalStack except the first delete. This
    // simulates the process dying after PostgreSQL commits but before SQS ack.
    faultingSqs = new SQSClient(sqsOptions);
    faultingSqs.middlewareStack.add(
      (next) => async (args) => {
        const input = args.input as { QueueUrl?: string; ReceiptHandle?: string; VisibilityTimeout?: number };
        if (!faultInjected && input.QueueUrl === queueUrl && input.ReceiptHandle && input.VisibilityTimeout === undefined) {
          faultInjected = true;
          throw new Error('simulated worker crash after database commit and before SQS ack');
        }
        return next(args);
      },
      { step: 'initialize', name: 'simulateFirstAckFailure', priority: 'high' },
    );

    const processWager = new ProcessWagerTransaction(orm.em.fork(), new AppMetrics());
    const firstConsumer = new WagerSqsConsumer(faultingSqs, processWager, new AppMetrics(), queueUrl);
    await firstConsumer.poll();
    expect(faultInjected).toBe(true);

    const committedWallet = await fetch(`${appUrl}/wallets/${wallet.id}`).then((response) => response.json()) as {
      balance: { amount: string }; version: number;
    };
    expect(committedWallet.balance.amount).toBe('90.00');
    expect(committedWallet.version).toBe(2);

    // The consumer changes visibility for retry; wait for the same real SQS message to reappear.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const retryConsumer = new WagerSqsConsumer(sqs, processWager, new AppMetrics(), queueUrl);
    await retryConsumer.poll();

    const finalWallet = await fetch(`${appUrl}/wallets/${wallet.id}`).then((response) => response.json()) as {
      balance: { amount: string }; version: number;
    };
    expect(finalWallet.balance.amount).toBe('90.00');
    expect(finalWallet.version).toBe(2);

    const ledger = await fetch(`${appUrl}/wallets/${wallet.id}/ledger`).then((response) => response.json()) as {
      items: Array<{ direction: string; money: { amount: string } }>;
    };
    expect(ledger.items.filter((item) => item.direction === 'DEBIT' && item.money.amount === '10.00')).toHaveLength(1);

    const inboxRows = await orm.em.getConnection().execute<any[]>(
      `select count(*)::int as count from inbox_message where consumer_name = 'wager-transaction-consumer-v1' and message_id = ?`,
      [sentMessage.MessageId],
    );
    expect(inboxRows[0].count).toBe(1);
    const queueAttributes = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages'],
    }));
    expect(Number(queueAttributes.Attributes?.ApproximateNumberOfMessages ?? 0)).toBe(0);

  } finally {
    await orm.close(true);
    await faultingSqs?.destroy();
    if (queueUrl) await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    await sqs.destroy();
  }
}, 30_000);
