import { Injectable } from '@nestjs/common';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';

export interface DependencyHealth {
  status: 'ready' | 'not_ready';
  dependencies: { postgres: 'up' | 'down'; sqs: 'up' | 'down' };
}

@Injectable()
export class HealthService {
  private readonly sqs: SQSClient;
  private readonly queueUrl = process.env.SQS_WAGER_QUEUE_URL;

  constructor(private readonly em: EntityManager) {
    const endpoint = process.env.SQS_ENDPOINT;
    this.sqs = new SQSClient({
      region: process.env.SQS_REGION ?? 'us-east-1',
      ...(endpoint ? {
        endpoint,
        // LocalStack does not validate these values, but the AWS SDK requires credentials.
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      } : {}),
    });
  }

  async checkDependencies(): Promise<DependencyHealth> {
    const [postgres, sqs] = await Promise.all([
      this.checkPostgres(),
      this.checkSqs(),
    ]);
    const ready = postgres === 'up' && sqs === 'up';
    return {
      status: ready ? 'ready' : 'not_ready',
      dependencies: { postgres, sqs },
    };
  }

  private async checkPostgres(): Promise<'up' | 'down'> {
    try {
      await this.em.getConnection().execute('select 1');
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async checkSqs(): Promise<'up' | 'down'> {
    if (!this.queueUrl) return 'down';
    try {
      await this.sqs.send(new GetQueueAttributesCommand({
        QueueUrl: this.queueUrl,
        AttributeNames: ['QueueArn'],
      }));
      return 'up';
    } catch {
      return 'down';
    }
  }
}
