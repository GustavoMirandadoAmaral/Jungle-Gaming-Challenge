import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { DomainError } from '../../shared/domain/errors/domain-error.js';
import { FailureCode } from '../../shared/domain/errors/failure-codes.js';
import { ProcessWagerInput, ProcessWagerTransaction, InboxMessageAlreadyProcessed } from '../../wagering/application/process-wager-transaction.js';
import { WagerTransactionStatus } from '../../wagering/domain/enums/wager-transaction-status.enum.js';
import { AppMetrics } from '../../observability/app-metrics.js';

const CONSUMER_NAME = 'wager-transaction-consumer-v1';
const MAX_RETRY_VISIBILITY_SECONDS = 300;
const DEFAULT_MAX_RECEIVE_COUNT = 5;

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
  private readonly queueUrl?: string;
  private readonly dlqUrl?: string;
  private readonly visibilityTimeoutSeconds: number;
  private readonly maxReceiveCount: number;
  private lastDlqSampleAt = 0;

  constructor(
    private readonly sqs: SQSClient,
    private readonly processWager: ProcessWagerTransaction,
    private readonly metrics: AppMetrics,
    queueUrl = process.env.SQS_WAGER_QUEUE_URL,
    dlqUrl = process.env.SQS_WAGER_DLQ_URL,
    visibilityTimeoutSeconds = Number(process.env.SQS_WAGER_VISIBILITY_TIMEOUT_SECONDS) || 30,
    maxReceiveCount = Number(process.env.SQS_WAGER_MAX_RECEIVE_COUNT) || DEFAULT_MAX_RECEIVE_COUNT,
  ) {
    this.queueUrl = queueUrl;
    this.dlqUrl = dlqUrl;
    this.visibilityTimeoutSeconds = visibilityTimeoutSeconds;
    this.maxReceiveCount = Math.max(1, Math.floor(maxReceiveCount));
  }

  @Interval(500)
  async poll(): Promise<void> {
    if (this.stopping || this.polling || !this.queueUrl) return;
    this.polling = true;
    try {
      const response = await this.sqs.send(new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 10,
        VisibilityTimeout: this.visibilityTimeoutSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }));
      await this.refreshDlqGauge();
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
    let correlationId: string | undefined;
    let providerId: string | undefined;
    let walletId: string | undefined;
    let transactionId: string | undefined;
    let envelope: SqsWagerEnvelope | undefined;
    try {
      try {
        envelope = JSON.parse(message.Body) as SqsWagerEnvelope;
      } catch {
        throw new PermanentSqsMessageError('Message body is not valid JSON');
      }
      if (envelope.type !== 'WagerTransactionRequested' || !envelope.data) {
        throw new PermanentSqsMessageError('Message type or data is invalid');
      }
      correlationId = envelope.correlationId ?? envelope.messageId ?? message.MessageId;
      providerId = envelope.data.providerId;
      walletId = envelope.data.walletId;
      const result = await this.processWager.execute({
        ...envelope.data,
        correlationId,
        inboxMessage: { consumerName: CONSUMER_NAME, messageId: message.MessageId },
      });
      transactionId = result.transactionId;
      if (result.status === WagerTransactionStatus.Failed) {
        // Preserve the queue's native redrive behavior after the failed state
        // has been durably recorded in PostgreSQL.
        await this.deferForRedrive(message, true);
        console.error(JSON.stringify({ level: 'error', event: 'sqs_wager_failed_and_sent_to_redrive', messageId: message.MessageId, correlationId, transactionId, walletId, providerId, failureCode: result.failureCode }));
        return;
      }
      // execute() returns only after the wallet, ledger, transaction, outbox and inbox commit.
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }));
      console.log(JSON.stringify({ level: 'info', event: 'sqs_wager_acknowledged', messageId: message.MessageId, correlationId, transactionId: result.transactionId, walletId, providerId, status: result.status }));
    } catch (error) {
      if (error instanceof PermanentSqsMessageError) {
        this.metrics.recordRetry('sqs');
        await this.deferForRedrive(message, true);
        console.error(JSON.stringify({ level: 'error', event: 'sqs_wager_permanent_failure', messageId: message.MessageId, correlationId, transactionId, walletId, providerId, error: this.errorMessage(error) }));
        return;
      }
      if (error instanceof InboxMessageAlreadyProcessed || error instanceof DomainError) {
        if (error instanceof InboxMessageAlreadyProcessed) this.metrics.recordInboxDuplicate();
        // Duplicate deliveries and terminal business rejections must not be retried.
        await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }));
        console.log(JSON.stringify({ level: 'info', event: 'sqs_wager_terminal_acknowledged', messageId: message.MessageId, correlationId, transactionId, walletId, providerId, reason: this.errorMessage(error) }));
        return;
      }
      const receiveCount = Math.max(1, Number(message.Attributes?.ApproximateReceiveCount) || 1);
      if (receiveCount >= this.maxReceiveCount && envelope?.data) {
        try {
          const failed = await this.processWager.failPermanently(
            envelope.data,
            FailureCode.PERMANENT_INFRASTRUCTURE_FAILURE,
          );
          transactionId = failed.transactionId;
          if (failed.status === WagerTransactionStatus.Failed) {
            // The message stays unacknowledged. SQS moves it to the DLQ once
            // this final visibility expires, while PostgreSQL keeps the audit.
            await this.deferForRedrive(message, true);
            console.error(JSON.stringify({ level: 'error', event: 'sqs_wager_permanent_failure_recorded', messageId: message.MessageId, correlationId, transactionId, walletId, providerId, failureCode: failed.failureCode }));
            return;
          }
          // A concurrent instance may have committed the wager while this
          // instance was retrying a transient error. Respect that outcome.
          await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }));
          return;
        } catch (auditError) {
          console.error(JSON.stringify({ level: 'error', event: 'sqs_wager_permanent_failure_audit_failed', messageId: message.MessageId, correlationId, transactionId, walletId, providerId, error: this.errorMessage(auditError) }));
        }
      }
      this.metrics.recordRetry('sqs');
      await this.deferForRedrive(message, false);
      console.error(JSON.stringify({ level: 'error', event: 'sqs_wager_retry_scheduled', messageId: message.MessageId, correlationId, transactionId, walletId, providerId, error: this.errorMessage(error) }));
    }
  }

  private async refreshDlqGauge(): Promise<void> {
    const now = Date.now();
    if (!this.dlqUrl || now - this.lastDlqSampleAt < 10_000) return;
    this.lastDlqSampleAt = now;
    try {
      const response = await this.sqs.send(new GetQueueAttributesCommand({
        QueueUrl: this.dlqUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }));
      const visible = Number(response.Attributes?.ApproximateNumberOfMessages ?? 0);
      const inFlight = Number(response.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
      this.metrics.setDlqMessages(visible + inFlight);
    } catch (error) {
      console.error(JSON.stringify({ level: 'warn', event: 'dlq_metrics_refresh_failed', error: this.errorMessage(error) }));
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
    if (!(error instanceof Error)) return 'UnknownError';
    let current: unknown = error;
    for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
      const details = current as { code?: unknown; cause?: unknown };
      if (typeof details.code === 'string') return `${error.name} (${details.code})`;
      current = details.cause;
    }
    // Driver messages may embed SQL and serialized financial event payloads.
    // Keep logs useful without copying those values into application logs.
    return error.name || 'Error';
  }
}
