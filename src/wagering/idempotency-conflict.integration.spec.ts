import { expect, test } from 'bun:test';
import { v7 as uuidv7 } from 'uuid';
import { waitForApps } from '../test-utils/wait-for-apps.js';

const appUrls = [3001, 3002, 3003].map((port) => `http://localhost:${port}`);

test('reusing an idempotency key with a changed amount conflicts without changing wallet or ledger', async () => {
  await waitForApps(appUrls);
  const playerId = uuidv7();
  const walletResponse = await fetch(`${appUrls[0]}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }),
  });
  expect(walletResponse.status).toBe(201);
  const wallet = await walletResponse.json() as { id: string };

  const externalTransactionId = `idempotency-conflict-${uuidv7()}`;
  const idempotencyKey = `provider-conflict-test:${externalTransactionId}`;
  const originalBody = {
    providerId: 'provider-conflict-test',
    externalTransactionId,
    playerId,
    walletId: wallet.id,
    roundId: `round-${externalTransactionId}`,
    gameId: 'idempotency-conflict-test',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };
  const submit = (body: typeof originalBody) => fetch(`${appUrls[1]}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify(body),
  });

  const firstResponse = await submit(originalBody);
  expect(firstResponse.status).toBe(200);
  const first = await firstResponse.json() as { transactionId: string; balance: { amount: string }; idempotentReplay: boolean };
  expect(first.idempotentReplay).toBe(false);
  expect(first.balance.amount).toBe('75.00');

  const conflictingResponse = await submit({
    ...originalBody,
    money: { amount: '26.00', currency: 'BRL' },
  });
  expect(conflictingResponse.status).toBe(409);
  const conflict = await conflictingResponse.json() as { code: string };
  expect(conflict.code).toBe('IDEMPOTENCY_CONFLICT');

  const [walletAfterConflict, ledgerAfterConflict] = await Promise.all([
    fetch(`${appUrls[2]}/wallets/${wallet.id}`).then((response) => response.json()) as Promise<{ balance: { amount: string }; version: number }>,
    fetch(`${appUrls[2]}/wallets/${wallet.id}/ledger`).then((response) => response.json()) as Promise<{
      items: Array<{ transactionId: string; direction: string; money: { amount: string } }>;
    }>,
  ]);
  expect(walletAfterConflict.balance.amount).toBe('75.00');
  expect(walletAfterConflict.version).toBe(2);
  expect(ledgerAfterConflict.items.filter((entry) => entry.direction === 'DEBIT' && entry.money.amount === '25.00')).toHaveLength(1);
  expect(ledgerAfterConflict.items.filter((entry) => entry.transactionId === first.transactionId)).toHaveLength(1);
});
