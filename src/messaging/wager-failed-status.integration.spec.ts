import { expect, test } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
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

test('SQS retry exhaustion persists FAILED without changing the wallet, then sends the message to the DLQ', async () => {
  await waitForApps([appUrl]);
  const sqs = new SQSClient(sqsOptions);
  const orm = await MikroORM.init(mikroOrmConfig);
  const suffix = uuidv7().replaceAll('-', '');
  const queueName = `failed-wager-${suffix}.fifo`;
  const dlqName = `failed-wager-dlq-${suffix}.fifo`;
  const triggerName = `test_failed_outbox_${suffix}`;
  const functionName = `test_failed_outbox_fn_${suffix}`;
  const externalTransactionId = `failed-${uuidv7()}`;
  const correlationId = uuidv7();
  let queueUrl: string | undefined;
  let dlqUrl: string | undefined;
  let triggerInstalled = false;

  try {
    const dlq = await sqs.send(new CreateQueueCommand({
      QueueName: dlqName,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }));
    dlqUrl = dlq.QueueUrl;
    expect(dlqUrl).toBeTruthy();
    const dlqAttributes = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: dlqUrl,
      AttributeNames: ['QueueArn'],
    }));
    const dlqArn = dlqAttributes.Attributes?.QueueArn;
    expect(dlqArn).toBeTruthy();

    const queue = await sqs.send(new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: '2' }),
      },
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

    const envelope = {
      messageId: uuidv7(),
      type: 'WagerTransactionRequested',
      correlationId,
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'failed-wager-integration-test',
        externalTransactionId,
        idempotencyKey: `failed-wager-integration-test:${externalTransactionId}`,
        playerId,
        walletId: wallet.id,
        roundId: `round-${externalTransactionId}`,
        gameId: 'failed-wager-integration-test',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      },
    };
    const sent = await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(envelope),
      MessageGroupId: wallet.id,
      MessageDeduplicationId: envelope.messageId,
    }));
    expect(sent.MessageId).toBeTruthy();

    // Simulate a repeatable infrastructure failure late in the financial
    // transaction. The wager transaction itself must roll back each time.
    await orm.em.getConnection().execute(
      `create function ${functionName}() returns trigger language plpgsql as $$
       begin
         if NEW.payload->>'correlationId' = '${correlationId}' then
           raise exception 'injected permanent infrastructure failure for FAILED integration test';
         end if;
         return NEW;
       end;
       $$`,
    );
    await orm.em.getConnection().execute(
      `create trigger ${triggerName} before insert on outbox_message
       for each row execute function ${functionName}()`,
    );
    triggerInstalled = true;

    const metrics = new AppMetrics();
    const processWager = new ProcessWagerTransaction(orm.em.fork(), metrics);
    const consumer = new WagerSqsConsumer(sqs, processWager, metrics, queueUrl, dlqUrl, 1, 2);
    await consumer.poll(); // receive 1: transient retry

    const attemptsBeforeFinal = await orm.em.getConnection().execute<any[]>(
      `select count(*)::int as count from wager_transaction
       where provider_id = ? and external_transaction_id = ?`,
      ['failed-wager-integration-test', externalTransactionId],
    );
    expect(Number(attemptsBeforeFinal[0].count)).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 2500));
    await consumer.poll(); // receive 2: retry budget exhausted, persist FAILED

    const failedRows = await orm.em.getConnection().execute<any[]>(
      `select id, status, failure_code as "failureCode", resulting_balance::text as "resultingBalance"
       from wager_transaction where provider_id = ? and external_transaction_id = ?`,
      ['failed-wager-integration-test', externalTransactionId],
    );
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0].status).toBe('FAILED');
    expect(failedRows[0].failureCode).toBe('PERMANENT_INFRASTRUCTURE_FAILURE');
    expect(String(failedRows[0].resultingBalance)).toBe('100.00');

    const walletAfterFailure = await fetch(`${appUrl}/wallets/${wallet.id}`).then((response) => response.json()) as {
      balance: { amount: string }; version: number;
    };
    expect(walletAfterFailure.balance.amount).toBe('100.00');
    expect(walletAfterFailure.version).toBe(1);

    const ledger = await orm.em.getConnection().execute<any[]>(
      'select direction, amount::text from wallet_ledger_entry where wallet_id = ?',
      [wallet.id],
    );
    expect(ledger).toHaveLength(1); // only the OPENING credit

    // Some SQS emulators perform the redrive on the next receive after the
    // configured threshold has been reached.
    await consumer.poll();

    const deadline = Date.now() + 10_000;
    let deadLetterMessage: { Body?: string } | undefined;
    while (Date.now() < deadline && !deadLetterMessage) {
      const response = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: dlqUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
      }));
      deadLetterMessage = response.Messages?.find((message) => message.Body === JSON.stringify(envelope));
    }
    expect(deadLetterMessage?.Body).toBe(JSON.stringify(envelope));

    await orm.em.getConnection().execute(`drop trigger ${triggerName} on outbox_message`);
    await orm.em.getConnection().execute(`drop function ${functionName}()`);
    triggerInstalled = false;
  } finally {
    if (triggerInstalled) {
      await orm.em.getConnection().execute(`drop trigger if exists ${triggerName} on outbox_message`);
      await orm.em.getConnection().execute(`drop function if exists ${functionName}()`);
    }
    if (queueUrl) await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    if (dlqUrl) await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
    await orm.close(true);
    await sqs.destroy();
  }
}, 45_000);
