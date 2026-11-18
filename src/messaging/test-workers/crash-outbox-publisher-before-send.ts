import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import mikroOrmConfig from '../../mikro-orm.config.js';
import { AppMetrics } from '../../observability/app-metrics.js';
import { OutboxPublisher } from '../application/outbox-publisher.js';

const eventId = process.env.TEST_OUTBOX_EVENT_ID;
if (!eventId) throw new Error('TEST_OUTBOX_EVENT_ID is required');

const sqs = new SQSClient({
  endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
  region: process.env.SQS_REGION ?? 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

// The outbox claim has committed before OutboxPublisher sends this command.
// Exit the child at that boundary so its in-memory state disappears while the
// PostgreSQL lease remains durable and can be recovered by another instance.
sqs.middlewareStack.add(
  (next) => async (args) => {
    const input = args.input as SendMessageCommand['input'];
    if (input.MessageDeduplicationId === eventId) {
      console.log(`simulating publisher process death before SQS send for ${eventId}`);
      process.exit(137);
    }
    return next(args);
  },
  { step: 'initialize', name: 'exitBeforeOutboxSend', priority: 'high' },
);

const orm = await MikroORM.init(mikroOrmConfig);
try {
  const publisher = new OutboxPublisher(orm.em.fork(), sqs, new AppMetrics());
  await publisher.publishPending();
} finally {
  await orm.close(true);
  await sqs.destroy();
}
