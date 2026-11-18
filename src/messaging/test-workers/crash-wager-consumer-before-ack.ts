import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import mikroOrmConfig from '../../mikro-orm.config.js';
import { AppMetrics } from '../../observability/app-metrics.js';
import { ProcessWagerTransaction } from '../../wagering/application/process-wager-transaction.js';
import { WagerSqsConsumer } from '../application/wager-sqs-consumer.js';

const queueUrl = process.env.TEST_WAGER_QUEUE_URL;
const expectedMessageId = process.env.TEST_SQS_MESSAGE_ID;
if (!queueUrl || !expectedMessageId) throw new Error('TEST_WAGER_QUEUE_URL and TEST_SQS_MESSAGE_ID are required');

const sqs = new SQSClient({
  endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
  region: process.env.SQS_REGION ?? 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

// WagerSqsConsumer reaches DeleteMessage only after ProcessWagerTransaction
// returns, which means PostgreSQL has committed wallet, ledger, inbox and outbox.
// Terminating here leaves the real SQS message unacknowledged for redelivery.
sqs.middlewareStack.add(
  (next) => async (args) => {
    const input = args.input as { QueueUrl?: string; ReceiptHandle?: string };
    if (input.QueueUrl === queueUrl && input.ReceiptHandle) {
      console.log(`simulating worker process death after commit and before SQS ack for ${expectedMessageId}`);
      process.exit(137);
    }
    return next(args);
  },
  { step: 'initialize', name: 'exitBeforeWagerAck', priority: 'high' },
);

const orm = await MikroORM.init(mikroOrmConfig);
try {
  const metrics = new AppMetrics();
  const processWager = new ProcessWagerTransaction(orm.em.fork(), metrics);
  const consumer = new WagerSqsConsumer(
    sqs,
    processWager,
    metrics,
    queueUrl,
    undefined,
    Number(process.env.SQS_WAGER_VISIBILITY_TIMEOUT_SECONDS) || 30,
  );
  await consumer.poll();
} finally {
  await orm.close(true);
  await sqs.destroy();
}
