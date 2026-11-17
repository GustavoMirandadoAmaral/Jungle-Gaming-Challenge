import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { v7 as uuidv7 } from 'uuid';
import { waitForApps } from '../test-utils/wait-for-apps.js';

const appUrls = [3001, 3002, 3003].map((port) => `http://localhost:${port}`);

test('idempotency and ledger remain correct after restarting an app instance', async () => {
  await waitForApps(appUrls);
  const playerId = uuidv7();
  const createResponse = await fetch(`${appUrls[1]}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }),
  });
  expect(createResponse.status).toBe(201);
  const wallet = await createResponse.json() as { id: string };

  const externalTransactionId = `restart-${uuidv7()}`;
  const idempotencyKey = `restart-test:${externalTransactionId}`;
  const body = {
    providerId: 'restart-recovery-test',
    externalTransactionId,
    playerId,
    walletId: wallet.id,
    roundId: `round-${externalTransactionId}`,
    gameId: 'restart-recovery-test',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };
  const submit = () => fetch(`${appUrls[0]}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify(body),
  });

  const firstResponse = await submit();
  expect(firstResponse.status).toBe(200);
  const first = await firstResponse.json() as { transactionId: string; status: string; idempotentReplay: boolean };
  expect(first.status).toBe('PROCESSED');
  expect(first.idempotentReplay).toBe(false);

  const restart = spawnSync('docker', ['compose', 'restart', 'app-1'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  expect(restart.status).toBe(0);
  await waitForApps(appUrls);

  const retryResponse = await submit();
  expect(retryResponse.status).toBe(200);
  const retry = await retryResponse.json() as { transactionId: string; status: string; idempotentReplay: boolean; balance: { amount: string } };
  expect(retry.transactionId).toBe(first.transactionId);
  expect(retry.status).toBe('PROCESSED');
  expect(retry.idempotentReplay).toBe(true);
  expect(retry.balance.amount).toBe('75.00');

  const [walletResponse, ledgerResponse] = await Promise.all([
    fetch(`${appUrls[2]}/wallets/${wallet.id}`),
    fetch(`${appUrls[2]}/wallets/${wallet.id}/ledger`),
  ]);
  const finalWallet = await walletResponse.json() as { balance: { amount: string }; version: number };
  const ledger = await ledgerResponse.json() as { items: Array<{ direction: string; transactionId: string }> };
  expect(finalWallet.balance.amount).toBe('75.00');
  expect(finalWallet.version).toBe(2);
  expect(ledger.items.filter((entry) => entry.direction === 'DEBIT' && entry.transactionId === first.transactionId)).toHaveLength(1);
}, 45_000);
