import { Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { SQSClient } from '@aws-sdk/client-sqs';
import { WageringModule } from '../wagering/wagering.module.js';
import { ProcessWagerTransaction } from '../wagering/application/process-wager-transaction.js';
import { OutboxPublisher } from './application/outbox-publisher.js';
import { WagerSqsConsumer } from './application/wager-sqs-consumer.js';
import { AppMetrics } from '../observability/app-metrics.js';

const SQS_CLIENT = 'SQS_CLIENT';

function createSqsClient(): SQSClient {
  const endpoint = process.env.SQS_ENDPOINT;
  return new SQSClient({
    region: process.env.SQS_REGION ?? 'us-east-1',
    ...(endpoint ? {
      endpoint,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    } : {}),
  });
}

@Module({
  imports: [WageringModule],
  providers: [
    { provide: SQS_CLIENT, useFactory: createSqsClient },
    {
      provide: OutboxPublisher,
      useFactory: (em: EntityManager, sqs: SQSClient, metrics: AppMetrics) => new OutboxPublisher(em, sqs, metrics),
      inject: [EntityManager, SQS_CLIENT, AppMetrics],
    },
    {
      provide: WagerSqsConsumer,
      useFactory: (sqs: SQSClient, processWager: ProcessWagerTransaction, metrics: AppMetrics) => new WagerSqsConsumer(sqs, processWager, metrics),
      inject: [SQS_CLIENT, ProcessWagerTransaction, AppMetrics],
    },
  ],
  exports: [],
})
export class MessagingModule {}
