import { expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { v7 as uuidv7 } from 'uuid';
import mikroOrmConfig from '../mikro-orm.config.js';
import { waitForApps } from '../test-utils/wait-for-apps.js';

const appUrls = [3001, 3002, 3003].map((port) => `http://localhost:${port}`);

test('transaction queries, ledger reconciliation, and pending reference expiry use persistent PostgreSQL state', async () => {
  await waitForApps(appUrls);
  const orm = await MikroORM.init(mikroOrmConfig);
  try {
    const playerId = uuidv7();
    const createdWalletResponse = await fetch(`${appUrls[0]}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }),
    });
    expect(createdWalletResponse.status).toBe(201);
    const wallet = await createdWalletResponse.json() as { id: string };

    const externalTransactionId = `query-bet-${uuidv7()}`;
    const wagerResponse = await fetch(`${appUrls[1]}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `query:${uuidv7()}` },
      body: JSON.stringify({
        providerId: 'query-reconciliation-integration-test', externalTransactionId,
        playerId, walletId: wallet.id, roundId: 'query-round', gameId: 'query-game',
        kind: 'BET', money: { amount: '15.00', currency: 'BRL' },
      }),
    });
    expect(wagerResponse.status).toBe(200);
    const wager = await wagerResponse.json() as { transactionId: string; status: string };
    expect(wager.status).toBe('PROCESSED');

    const metricsResponse = await fetch(`${appUrls[1]}/metrics`);
    expect(metricsResponse.status).toBe(200);
    expect(await metricsResponse.text()).toMatch(/wager_transactions_total\{status="PROCESSED"\} [1-9]\d*/);

    const [byIdResponse, byExternalResponse] = await Promise.all([
      fetch(`${appUrls[2]}/wagering/transactions/${wager.transactionId}`),
      fetch(`${appUrls[0]}/providers/query-reconciliation-integration-test/wagering/transactions/${externalTransactionId}`),
    ]);
    expect(byIdResponse.status).toBe(200);
    expect(byExternalResponse.status).toBe(200);
    const byId = await byIdResponse.json() as { id: string; status: string; resultingBalance: { amount: string } };
    const byExternal = await byExternalResponse.json() as { id: string; externalTransactionId: string };
    expect(byId.id).toBe(wager.transactionId);
    expect(byId.status).toBe('PROCESSED');
    expect(byId.resultingBalance.amount).toBe('85.00');
    expect(byExternal.id).toBe(wager.transactionId);
    expect(byExternal.externalTransactionId).toBe(externalTransactionId);

    const reconciliationResponse = await fetch(`${appUrls[1]}/wallets/${wallet.id}/reconciliation`, { method: 'POST' });
    expect(reconciliationResponse.status).toBe(201);
    const reconciliation = await reconciliationResponse.json() as {
      consistent: boolean; storedBalance: { amount: string }; calculatedBalance: { amount: string }; checkedEntries: number;
    };
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.storedBalance.amount).toBe('85.00');
    expect(reconciliation.calculatedBalance.amount).toBe('85.00');
    expect(reconciliation.checkedEntries).toBe(2);

    const pendingExternalId = `unarrived-bet-${uuidv7()}`;
    const pendingResponse = await fetch(`${appUrls[2]}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `pending:${uuidv7()}` },
      body: JSON.stringify({
        providerId: 'query-reconciliation-integration-test', externalTransactionId: `early-refund-${uuidv7()}`,
        playerId, walletId: wallet.id, roundId: 'query-round', gameId: 'query-game', kind: 'REFUND',
        money: { amount: '5.00', currency: 'BRL' }, referenceExternalTransactionId: pendingExternalId,
      }),
    });
    expect(pendingResponse.status).toBe(202);
    const pending = await pendingResponse.json() as { transactionId: string; status: string };
    expect(pending.status).toBe('PENDING_REFERENCE');

    // Age the persisted row so the real scheduled worker expires it promptly.
    await orm.em.getConnection().execute(
      `update wager_transaction set created_at = now() - interval '2 hours' where id = ?`,
      [pending.transactionId],
    );
    const expiryDeadline = Date.now() + 12_000;
    let expired: { status: string; failureCode?: string } | undefined;
    while (Date.now() < expiryDeadline) {
      const response = await fetch(`${appUrls[0]}/wagering/transactions/${pending.transactionId}`);
      expired = await response.json() as typeof expired;
      if (expired?.status === 'REJECTED') break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(expired?.status).toBe('REJECTED');
    expect(expired?.failureCode).toBe('REFERENCE_NOT_FOUND');

    const finalWalletResponse = await fetch(`${appUrls[0]}/wallets/${wallet.id}`);
    const finalWallet = await finalWalletResponse.json() as { balance: { amount: string }; version: number };
    expect(finalWallet.balance.amount).toBe('85.00');
    expect(finalWallet.version).toBe(2);
  } finally {
    await orm.close(true);
  }
}, 30_000);
