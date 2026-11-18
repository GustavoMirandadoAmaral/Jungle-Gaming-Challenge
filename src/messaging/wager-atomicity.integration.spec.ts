import { expect, test } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  SQSClient,
  SendMessageCommand,
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

test('outbox insertion failure rolls back wallet, ledger, wager, and inbox before SQS retry', async () => {
  await waitForApps([appUrl]);
  const sqs = new SQSClient(sqsOptions);
  const orm = await MikroORM.init(mikroOrmConfig);
  const queueName = `wager-atomicity-${uuidv7()}.fifo`;
  const suffix = uuidv7().replaceAll('-', '');
  const triggerName = `test_outbox_fail_${suffix}`;
  const functionName = `test_outbox_fail_fn_${suffix}`;
  const externalTransactionId = `atomicity-${uuidv7()}`;
  const correlationId = uuidv7();
  let queueUrl: string | undefined;
  let triggerInstalled = false;

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
    const message = await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        messageId: uuidv7(),
        type: 'WagerTransactionRequested',
        correlationId,
        occurredAt: new Date().toISOString(),
        data: {
          providerId: 'wager-atomicity-test',
          externalTransactionId,
          idempotencyKey: `wager-atomicity-test:${externalTransactionId}`,
          playerId,
          walletId: wallet.id,
          roundId: `round-${externalTransactionId}`,
          gameId: 'wager-atomicity-test',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        },
      }),
      MessageGroupId: wallet.id,
      MessageDeduplicationId: uuidv7(),
    }));
    expect(message.MessageId).toBeTruthy();

    // Make only this wager's outbox write fail. The trigger runs inside the
    // real financial transaction, after wallet, ledger, wager and inbox writes.
    await orm.em.getConnection().execute(
      `create function ${functionName}() returns trigger language plpgsql as $$
       begin
         if NEW.payload->'data'->>'externalTransactionId' = '${externalTransactionId}' then
           raise exception 'injected outbox failure for atomicity integration test';
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
    const consumer = new WagerSqsConsumer(sqs, processWager, metrics, queueUrl, undefined, 1);
    await consumer.poll();

    const walletAfterFailure = await fetch(`${appUrl}/wallets/${wallet.id}`).then((response) => response.json()) as {
      balance: { amount: string }; version: number;
    };
    expect(walletAfterFailure.balance.amount).toBe('100.00');
    expect(walletAfterFailure.version).toBe(1);

    const rolledBack = await orm.em.getConnection().execute<any[]>(
      `select
         (select count(*)::int from wager_transaction where provider_id = ? and external_transaction_id = ?) as wagers,
         (select count(*)::int from wallet_ledger_entry where wallet_id = ?) as ledger_entries,
         (select count(*)::int from inbox_message where consumer_name = 'wager-transaction-consumer-v1' and message_id = ?) as inbox_entries,
         (select count(*)::int from outbox_message where payload->>'correlationId' = ?) as outbox_entries`,
      ['wager-atomicity-test', externalTransactionId, wallet.id, message.MessageId, correlationId],
    );
    expect(Number(rolledBack[0].wagers)).toBe(0);
    expect(Number(rolledBack[0].ledger_entries)).toBe(1); // only the OPENING credit
    expect(Number(rolledBack[0].inbox_entries)).toBe(0);
    expect(Number(rolledBack[0].outbox_entries)).toBe(0);

    await orm.em.getConnection().execute(`drop trigger ${triggerName} on outbox_message`);
    await orm.em.getConnection().execute(`drop function ${functionName}()`);
    triggerInstalled = false;

    // The consumer scheduled a real visibility retry. With the injected failure
    // removed, the same SQS message can atomically commit all four records.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await consumer.poll();

    const walletAfterRetry = await fetch(`${appUrl}/wallets/${wallet.id}`).then((response) => response.json()) as {
      balance: { amount: string }; version: number;
    };
    expect(walletAfterRetry.balance.amount).toBe('90.00');
    expect(walletAfterRetry.version).toBe(2);
    const committed = await orm.em.getConnection().execute<any[]>(
      `select
         (select count(*)::int from wager_transaction where provider_id = ? and external_transaction_id = ?) as wagers,
         (select count(*)::int from wallet_ledger_entry where wallet_id = ?) as ledger_entries,
         (select count(*)::int from inbox_message where consumer_name = 'wager-transaction-consumer-v1' and message_id = ?) as inbox_entries,
         (select count(*)::int from outbox_message where payload->>'correlationId' = ?) as outbox_entries`,
      ['wager-atomicity-test', externalTransactionId, wallet.id, message.MessageId, correlationId],
    );
    expect(Number(committed[0].wagers)).toBe(1);
    expect(Number(committed[0].ledger_entries)).toBe(2); // OPENING plus one BET debit
    expect(Number(committed[0].inbox_entries)).toBe(1);
    expect(Number(committed[0].outbox_entries)).toBe(2); // processed event plus balance change

    const queueState = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }));
    expect(Number(queueState.Attributes?.ApproximateNumberOfMessages ?? 0)).toBe(0);
    expect(Number(queueState.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)).toBe(0);
  } finally {
    if (triggerInstalled) {
      await orm.em.getConnection().execute(`drop trigger if exists ${triggerName} on outbox_message`);
      await orm.em.getConnection().execute(`drop function if exists ${functionName}()`);
    }
    await orm.close(true);
    if (queueUrl) await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    await sqs.destroy();
  }
}, 30_000);
