import { expect, test } from 'bun:test';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { v7 as uuidv7 } from 'uuid';

const endpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
const region = process.env.SQS_REGION ?? 'us-east-1';
const inputQueue = process.env.TEST_SQS_WAGER_QUEUE_URL ?? 'http://localhost:4566/000000000000/wager-transactions.fifo';
const dlq = process.env.TEST_SQS_WAGER_DLQ_URL ?? 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo';
const sqs = new SQSClient({ endpoint, region, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });

test('permanently malformed SQS messages are moved to the configured DLQ', async () => {
  const messageId = uuidv7();
  const invalidBody = `{invalid-json-${messageId}`;
  await sqs.send(new SendMessageCommand({
    QueueUrl: inputQueue,
    MessageBody: invalidBody,
    MessageGroupId: `dlq-${messageId}`,
    MessageDeduplicationId: messageId,
  }));

  const deadline = Date.now() + 20_000;
  let deadLetterMessage: { MessageId?: string; ReceiptHandle?: string; Body?: string } | undefined;
  while (Date.now() < deadline && !deadLetterMessage) {
    const response = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: dlq,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 1,
      VisibilityTimeout: 5,
    }));
    deadLetterMessage = response.Messages?.find((message) => message.Body === invalidBody);
    for (const other of response.Messages ?? []) {
      if (other.Body !== invalidBody && other.ReceiptHandle) {
        await sqs.send(new ChangeMessageVisibilityCommand({
          QueueUrl: dlq,
          ReceiptHandle: other.ReceiptHandle,
          VisibilityTimeout: 5,
        }));
      }
    }
  }

  expect(deadLetterMessage?.Body).toBe(invalidBody);
  if (deadLetterMessage?.ReceiptHandle) {
    await sqs.send(new DeleteMessageCommand({ QueueUrl: dlq, ReceiptHandle: deadLetterMessage.ReceiptHandle }));
  }
}, 30_000);
