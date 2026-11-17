import { expect, test } from 'bun:test';
import { v7 as uuidv7 } from 'uuid';
import { waitForApps } from '../test-utils/wait-for-apps.js';

const appUrls = [3001, 3002, 3003].map((port) => `http://localhost:${port}`);
const providerId = 'concurrency-test-provider';
const playerId = () => uuidv7();

interface WalletResponse {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

interface WagerResponse {
  transactionId: string;
  status: 'PROCESSED' | 'REJECTED';
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
  failureCode?: string;
}

async function createWallet(initialAmount: string): Promise<WalletResponse> {
  const response = await fetch(`${appUrls[0]}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: playerId(),
      initialBalance: { amount: initialAmount, currency: 'BRL' },
    }),
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<WalletResponse>;
}

function wagerBody(wallet: WalletResponse, externalTransactionId: string, amount: string) {
  return {
    providerId,
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `round-${externalTransactionId}`,
    gameId: 'concurrency-test-game',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

async function submit(
  appUrl: string,
  idempotencyKey: string,
  body: ReturnType<typeof wagerBody>,
): Promise<{ httpStatus: number; body: WagerResponse }> {
  const response = await fetch(`${appUrl}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  return { httpStatus: response.status, body: await response.json() as WagerResponse };
}

async function readWallet(walletId: string): Promise<WalletResponse> {
  const response = await fetch(`${appUrls[0]}/wallets/${walletId}`);
  expect(response.status).toBe(200);
  return response.json() as Promise<WalletResponse>;
}

async function readLedger(walletId: string) {
  const response = await fetch(`${appUrls[0]}/wallets/${walletId}/ledger`);
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    items: Array<{ direction: string; money: { amount: string } }>;
  }>;
}

test('50 identical concurrent submissions across 3 app instances create one debit', async () => {
  await waitForApps(appUrls);
  const wallet = await createWallet('1000.00');
  const body = wagerBody(wallet, `same-${uuidv7()}`, '1.00');
  const key = `${providerId}:${body.externalTransactionId}`;

  const results = await Promise.all(
    Array.from({ length: 50 }, (_, index) => submit(appUrls[index % appUrls.length], key, body)),
  );

  expect(results.every((result) => result.httpStatus === 200)).toBe(true);
  expect(new Set(results.map((result) => result.body.transactionId)).size).toBe(1);
  expect(results.filter((result) => !result.body.idempotentReplay)).toHaveLength(1);
  expect(results.filter((result) => result.body.idempotentReplay)).toHaveLength(49);

  const finalWallet = await readWallet(wallet.id);
  expect(finalWallet.balance).toEqual({ amount: '999.00', currency: 'BRL' });
  expect(finalWallet.version).toBe(2);
  const ledger = await readLedger(wallet.id);
  expect(ledger.items.filter((item) => item.direction === 'DEBIT')).toHaveLength(1);
}, 30_000);

test('different concurrent bets cannot overspend the same wallet', async () => {
  await waitForApps(appUrls);
  const wallet = await createWallet('1000.00');
  const bodyA = wagerBody(wallet, `race-a-${uuidv7()}`, '600.00');
  const bodyB = wagerBody(wallet, `race-b-${uuidv7()}`, '600.00');

  const results = await Promise.all([
    submit(appUrls[0], `${providerId}:${bodyA.externalTransactionId}`, bodyA),
    submit(appUrls[1], `${providerId}:${bodyB.externalTransactionId}`, bodyB),
  ]);

  expect(results.map((result) => result.body.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
  expect(results.filter((result) => result.body.status === 'PROCESSED')[0].httpStatus).toBe(200);
  expect(results.filter((result) => result.body.status === 'REJECTED')[0].httpStatus).toBe(422);

  const finalWallet = await readWallet(wallet.id);
  expect(finalWallet.balance).toEqual({ amount: '400.00', currency: 'BRL' });
  expect(finalWallet.version).toBe(2);
  const ledger = await readLedger(wallet.id);
  expect(ledger.items.filter((item) => item.direction === 'DEBIT')).toHaveLength(1);
}, 30_000);

test('different wallets make progress concurrently across separate app instances', async () => {
  await waitForApps(appUrls);
  const [walletA, walletB] = await Promise.all([createWallet('100.00'), createWallet('100.00')]);
  const bodyA = wagerBody(walletA, `parallel-wallet-a-${uuidv7()}`, '75.00');
  const bodyB = wagerBody(walletB, `parallel-wallet-b-${uuidv7()}`, '60.00');

  const [resultA, resultB] = await Promise.all([
    submit(appUrls[0], `${providerId}:${bodyA.externalTransactionId}`, bodyA),
    submit(appUrls[2], `${providerId}:${bodyB.externalTransactionId}`, bodyB),
  ]);

  expect(resultA.body.status).toBe('PROCESSED');
  expect(resultB.body.status).toBe('PROCESSED');
  expect((await readWallet(walletA.id)).balance.amount).toBe('25.00');
  expect((await readWallet(walletB.id)).balance.amount).toBe('40.00');
});
