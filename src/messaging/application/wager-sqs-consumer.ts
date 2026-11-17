import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { DomainError } from '../../shared/domain/errors/domain-error.js';
import { ProcessWagerInput, ProcessWagerTransaction, InboxMessageAlreadyProcessed } from '../../wagering/application/process-wager-transaction.js';

const CONSUMER_NAME = 'wager-transaction-consumer-v1';
const MAX_RETRY_VISIBILITY_SECONDS = 300;

class PermanentSqsMessageError extends Error {}

interface SqsWagerEnvelope {
  messageId?: string;
  type: string;
  correlationId?: string;
  data: Omit<ProcessWagerInput, 'inboxMessage'>;
}

@Injectable()
export class WagerSqsConsumer implements OnModuleDestroy {
  private stopping = false;
  private polling = false;
  private readonly queueUrl = process.env.SQS_WAGER_QUEUE_URL;

  constructor(private readonly sqs: SQSClient, private readonly processWager: ProcessWagerTransaction) {}

  @Interval(500)
  async poll(): Promise<void> {
    if (this.stopping || this.polling || !this.queueUrl) return;
    this.polling = true;
    try {
      const response = await this.sqs.send(new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 10,
        VisibilityTimeout: 30,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }));
      await Promise.all((response.Messages ?? []).map((message) => this.handleMessage(message)));
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'sqs_receive_failed', error: this.errorMessage(error) }));
    } finally {
      this.polling = false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    while (this.polling) await new Promise((resolve) => setTimeout(resolve, 50));
  }

  private async handleMessage(message: {
    MessageId?: string;
    ReceiptHandle?: string;
    Body?: string;
    Attributes?: Record<string, string>;
  }): Promise<void> {
    if (!message.MessageId || !message.ReceiptHandle || !message.Body) return;
    try {
      let envelope: SqsWagerEnvelope;
      try {
        envelope = JSON.parse(message.Body) as SqsWagerEnvelope;
      } catch {
        throw new PermanentSqsMessageError('Message body is not valid JSON');
      }
      if (envelope.type !== 'WagerTransactionRequested' || !envelope.data) {
        throw new PermanentSqsMessageError('Message type or data is invalid');
      }
      const result = await this.processWager.execute({
        ...envelope.data,
        correlationId: envelope.correlationId ?? envelope.messageId ?? message.MessageId,
        inboxMessage: { consumerName: CONSUMER_NAME, messageId: message.MessageId },
      });
      // execute() returns only after the wallet, ledger, transaction, outbox and inbox commit.
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }));
      console.log(JSON.stringify({ level: 'info', event: 'sqs_wager_acknowledged', messageId: message.MessageId, transactionId: result.transactionId, status: result.status }));
    } catch (error) {
      if (error instanceof PermanentSqsMessageError) {
        await this.deferForRedrive(message, true);
        console.error(JSON.stringify({ level: 'error', event: 'sqs_wager_permanent_failure', messageId: message.MessageId, error: this.errorMessage(error) }));
        return;
      }
      if (error instanceof InboxMessageAlreadyProcessed || error instanceof DomainError) {
        // Duplicate deliveries and terminal business rejections must not be retried.
        await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }));
        console.log(JSON.stringify({ level: 'info', event: 'sqs_wager_terminal_acknowledged', messageId: message.MessageId, reason: this.errorMessage(error) }));
        return;
      }
      await this.deferForRedrive(message, false);
      console.error(JSON.stringify({ level: 'error', event: 'sqs_wager_retry_scheduled', messageId: message.MessageId, error: this.errorMessage(error) }));
    }
  }

  private async deferForRedrive(
    message: { MessageId?: string; ReceiptHandle?: string; Attributes?: Record<string, string> },
    permanent: boolean,
  ): Promise<void> {
    if (!message.ReceiptHandle) return;
    const receiveCount = Math.max(1, Number(message.Attributes?.ApproximateReceiveCount) || 1);
    const visibility = permanent
      ? 0
      : Math.min(2 ** Math.min(receiveCount, 8), MAX_RETRY_VISIBILITY_SECONDS);
    await this.sqs.send(new ChangeMessageVisibilityCommand({
      QueueUrl: this.queueUrl,
      ReceiptHandle: message.ReceiptHandle,
      VisibilityTimeout: visibility,
    }));
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
