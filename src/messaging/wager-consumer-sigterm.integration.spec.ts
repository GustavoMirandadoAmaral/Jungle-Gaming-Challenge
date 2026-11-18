import { expect, test } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { spawnSync } from 'node:child_process';
import { v7 as uuidv7 } from 'uuid';
import mikroOrmConfig from '../mikro-orm.config.js';
import { executeInTransaction } from '../database/execute-in-transaction.js';
import { waitForApps } from '../test-utils/wait-for-apps.js';

const appUrl = 'http://localhost:3001';
const sqsOptions = {
  endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
  region: process.env.SQS_REGION ?? 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
};

function docker(args: string[], timeout = 30_000) {
  return spawnSync('docker', args, { cwd: process.cwd(), encoding: 'utf8', timeout });
}

test('SIGTERM lets an in-flight SQS wager commit and ack before the consumer exits', async () => {
  await waitForApps([appUrl]);
  const sqs = new SQSClient(sqsOptions);
  const orm = await MikroORM.init(mikroOrmConfig);
  const queueName = `sigterm-consumer-${uuidv7()}.fifo`;
  const hostPort = 31_000 + Math.floor(Math.random() * 1_000);
  let queueUrl: string | undefined;
  let workerContainerId: string | undefined;
  let releaseWalletLock: (() => void) | undefined;
  let lockTransaction: Promise<void> | undefined;

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

    // The test worker runs the normal Nest application but listens to an
    // isolated real FIFO queue, so the other Compose consumers cannot take it.
    const containerQueueUrl = `http://localstack:4566/000000000000/${queueName}`;
    const startedWorker = docker([
      'compose', 'run', '--detach', '--no-deps', '--publish', `${hostPort}:3000`,
      '--env', `SQS_WAGER_QUEUE_URL=${containerQueueUrl}`,
      '--env', 'SQS_WAGER_VISIBILITY_TIMEOUT_SECONDS=30',
      'app-1',
    ]);
    expect(startedWorker.status).toBe(0);
    workerContainerId = startedWorker.stdout.trim().split(/\r?\n/).pop();
    expect(workerContainerId).toBeTruthy();
    await waitForApps([`http://localhost:${hostPort}`]);

    let signalWalletLockAcquired!: () => void;
    const walletLockAcquired = new Promise<void>((resolve) => { signalWalletLockAcquired = resolve; });
    let releaseLock!: () => void;
    const waitForRelease = new Promise<void>((resolve) => { releaseLock = resolve; });
    releaseWalletLock = releaseLock;
    lockTransaction = orm.em.transactional(async (tx) => {
      await executeInTransaction(
        tx,
        'select id from wallet where id = ? for update',
        [wallet.id],
      );
      signalWalletLockAcquired();
      await waitForRelease;
    });
    await walletLockAcquired;

    const externalTransactionId = `sigterm-${uuidv7()}`;
    const message = await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        messageId: uuidv7(),
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          providerId: 'sigterm-test',
          externalTransactionId,
          idempotencyKey: `sigterm-test:${externalTransactionId}`,
          playerId,
          walletId: wallet.id,
          roundId: `round-${externalTransactionId}`,
          gameId: 'sigterm-test',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        },
      }),
      MessageGroupId: wallet.id,
      MessageDeduplicationId: uuidv7(),
    }));
    expect(message.MessageId).toBeTruthy();

    const lockDeadline = Date.now() + 15_000;
    let waitingWorkerCount = 0;
    while (Date.now() < lockDeadline && waitingWorkerCount === 0) {
      const rows = await orm.em.getConnection().execute<any[]>(
        `select count(*)::int as count from pg_stat_activity
         where datname = current_database() and pid <> pg_backend_pid()
           and wait_event_type = 'Lock' and state = 'active'
           and query ilike '%for update%'`,
      );
      waitingWorkerCount = Number(rows[0].count);
      if (waitingWorkerCount === 0) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(waitingWorkerCount).toBeGreaterThan(0);

    const signaled = docker(['kill', '--signal=SIGTERM', workerContainerId!]);
    expect(signaled.status).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const running = docker(['inspect', '--format', '{{.State.Running}}', workerContainerId!]);
    expect(running.stdout.trim()).toBe('true');

    // Releasing the row lock lets the in-flight use case commit; Nest's
    // shutdown hook waits for poll() to finish and the consumer to ack it.
    releaseWalletLock();
    releaseWalletLock = undefined;
    await lockTransaction;
    lockTransaction = undefined;

    const exited = docker(['wait', workerContainerId!,], 20_000);
    expect(exited.status).toBe(0);
    expect(exited.stdout.trim()).toBe('0');

    const finalWallet = await fetch(`${appUrl}/wallets/${wallet.id}`).then((response) => response.json()) as {
      balance: { amount: string }; version: number;
    };
    expect(finalWallet.balance.amount).toBe('90.00');
    expect(finalWallet.version).toBe(2);

    const ledger = await fetch(`${appUrl}/wallets/${wallet.id}/ledger`).then((response) => response.json()) as {
      items: Array<{ direction: string; money: { amount: string } }>;
    };
    expect(ledger.items.filter((entry) => entry.direction === 'DEBIT' && entry.money.amount === '10.00')).toHaveLength(1);

    const inbox = await orm.em.getConnection().execute<any[]>(
      `select count(*)::int as count from inbox_message
       where consumer_name = 'wager-transaction-consumer-v1' and message_id = ?`,
      [message.MessageId],
    );
    expect(Number(inbox[0].count)).toBe(1);
    const queueState = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }));
    expect(Number(queueState.Attributes?.ApproximateNumberOfMessages ?? 0)).toBe(0);
    expect(Number(queueState.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)).toBe(0);
  } finally {
    releaseWalletLock?.();
    if (lockTransaction) await lockTransaction.catch(() => undefined);
    if (workerContainerId) {
      const running = docker(['inspect', '--format', '{{.State.Running}}', workerContainerId]);
      if (running.stdout.trim() === 'true') docker(['kill', '--signal=SIGKILL', workerContainerId]);
      docker(['rm', '--force', workerContainerId]);
    }
    if (queueUrl) await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    await orm.close(true);
    await sqs.destroy();
  }
}, 60_000);
