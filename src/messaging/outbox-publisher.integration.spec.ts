import { expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { v7 as uuidv7 } from 'uuid';
import mikroOrmConfig from '../mikro-orm.config.js';
import { waitForApps } from '../test-utils/wait-for-apps.js';

const appUrls = [3001, 3002, 3003].map((port) => `http://localhost:${port}`);

test('three live app instances publish committed outbox events to LocalStack SQS', async () => {
  await waitForApps(appUrls);
  const orm = await MikroORM.init(mikroOrmConfig);
  const walletIds: string[] = [];
  try {
    const createResults = await Promise.all(Array.from({ length: 18 }, async (_, index) => {
      const playerId = uuidv7();
      const response = await fetch(`${appUrls[index % appUrls.length]}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId, initialBalance: { amount: '5.00', currency: 'BRL' } }),
      });
      expect(response.status).toBe(201);
      return response.json() as Promise<{ id: string }>;
    }));
    walletIds.push(...createResults.map((wallet) => wallet.id));

    const deadline = Date.now() + 20_000;
    let pendingWallets = walletIds;
    while (Date.now() < deadline && pendingWallets.length > 0) {
      const counts = await Promise.all(pendingWallets.map(async (walletId) => {
        const rows = await orm.em.getConnection().execute<any[]>(
          `select count(*)::int as total, count(published_at)::int as published
           from outbox_message where payload->'data'->>'walletId' = ?`,
          [walletId],
        );
        return { walletId, total: Number(rows[0].total), published: Number(rows[0].published) };
      }));
      pendingWallets = counts.filter((row) => row.total !== 2 || row.published !== 2).map((row) => row.walletId);
      if (pendingWallets.length > 0) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(pendingWallets).toHaveLength(0);
  } finally {
    await orm.close(true);
  }
}, 30_000);
