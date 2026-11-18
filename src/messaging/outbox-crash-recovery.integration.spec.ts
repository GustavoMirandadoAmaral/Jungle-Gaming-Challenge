import { expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { spawnSync } from 'node:child_process';
import { v7 as uuidv7 } from 'uuid';
import mikroOrmConfig from '../mikro-orm.config.js';
import { waitForApps } from '../test-utils/wait-for-apps.js';

const appUrls = [3001, 3002, 3003].map((port) => `http://localhost:${port}`);
const appServices = ['app-1', 'app-2', 'app-3'];

function compose(args: string[]) {
  return spawnSync('docker', ['compose', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 30_000,
  });
}

test('another app instance publishes a committed outbox event after the claiming publisher process dies', async () => {
  await waitForApps(appUrls);
  const orm = await MikroORM.init(mikroOrmConfig);
  let appsNeedRestart = false;

  try {
    const idleDeadline = Date.now() + 20_000;
    let pendingCount = 1;
    while (Date.now() < idleDeadline && pendingCount > 0) {
      const rows = await orm.em.getConnection().execute<any[]>(
        'select count(*)::int as count from outbox_message where published_at is null',
      );
      pendingCount = Number(rows[0].count);
      if (pendingCount > 0) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(pendingCount).toBe(0);

    // Stop the regular publishers while arranging the crash boundary so this
    // row can only be claimed by the child publisher below.
    appsNeedRestart = true;
    const stopped = compose(['stop', ...appServices]);
    expect(stopped.status).toBe(0);

    const rowId = uuidv7();
    const eventId = uuidv7();
    const aggregateId = uuidv7();
    const correlationId = uuidv7();
    const transactionId = uuidv7();
    const walletId = uuidv7();
    const payload = {
      eventId,
      eventType: 'WagerTransactionProcessed',
      aggregateId,
      correlationId,
      occurredAt: new Date().toISOString(),
      version: 1,
      data: {
        transactionId,
        walletId,
        status: 'PROCESSED',
        money: { amount: '10.00', currency: 'BRL' },
      },
    };
    await orm.em.transactional(async (tx) => {
      await tx.getConnection().execute(
        `insert into outbox_message (id, event_id, event_type, aggregate_id, payload, occurred_at)
         values (?, ?, ?, ?, ?::jsonb, now())`,
        [rowId, eventId, payload.eventType, aggregateId, JSON.stringify(payload)],
        'all',
        tx.getTransactionContext(),
      );
    });

    const child = spawnSync(process.execPath, ['run', 'src/messaging/test-workers/crash-outbox-publisher-before-send.ts'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        SQS_ENDPOINT: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
        SQS_OUTBOX_QUEUE_URL: process.env.SQS_OUTBOX_QUEUE_URL ?? 'http://localhost:4566/000000000000/integration-events.fifo',
        TEST_OUTBOX_EVENT_ID: eventId,
      },
    });
    expect(child.status).toBe(137);
    expect(child.stdout).toContain(`simulating publisher process death before SQS send for ${eventId}`);

    const afterCrashRows = await orm.em.getConnection().execute<any[]>(
      `select attempts, published_at, locked_until > now() as lease_active
       from outbox_message where id = ?`,
      [rowId],
    );
    expect(Number(afterCrashRows[0].attempts)).toBe(1);
    expect(afterCrashRows[0].published_at).toBeNull();
    expect(afterCrashRows[0].lease_active).toBe(true);

    // Starting the real Compose instances supplies independent publishers.
    // They must wait for the crashed process's 60-second lease to expire.
    const started = compose(['start', ...appServices]);
    expect(started.status).toBe(0);
    await waitForApps(appUrls);

    const recoveryDeadline = Date.now() + 80_000;
    let recovered: any[] = [];
    while (Date.now() < recoveryDeadline) {
      recovered = await orm.em.getConnection().execute<any[]>(
        `select attempts, published_at from outbox_message where id = ?`,
        [rowId],
      );
      if (recovered[0]?.published_at) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(recovered[0]?.published_at).toBeTruthy();
    expect(Number(recovered[0].attempts)).toBe(2);
  } finally {
    if (appsNeedRestart) {
      const started = compose(['start', ...appServices]);
      if (started.status !== 0) {
        console.error(started.stderr || started.stdout || 'Failed to restart app services after outbox crash test');
      }
      await waitForApps(appUrls);
    }
    await orm.close(true);
  }
}, 120_000);
