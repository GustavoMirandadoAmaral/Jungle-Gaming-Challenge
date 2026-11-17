import { expect, test } from 'bun:test';
import { v7 as uuidv7 } from 'uuid';
import { waitForApps } from '../test-utils/wait-for-apps.js';

const appUrls = [3001, 3002, 3003].map((port) => `http://localhost:${port}`);

async function createWallet(amount: string) {
  const playerId = uuidv7();
  const response = await fetch(`${appUrls[0]}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency: 'BRL' } }),
  });
  expect(response.status).toBe(201);
  return { ...(await response.json() as { id: string }), playerId };
}

function body(params: {
  walletId: string; playerId: string; externalTransactionId: string; roundId: string;
  kind: 'BET' | 'WIN' | 'REFUND' | 'ROLLBACK'; amount: string; referenceExternalTransactionId?: string;
}) {
  return {
    providerId: 'reference-integration-test',
    externalTransactionId: params.externalTransactionId,
    playerId: params.playerId,
    walletId: params.walletId,
    roundId: params.roundId,
    gameId: 'reference-test-game',
    kind: params.kind,
    money: { amount: params.amount, currency: 'BRL' },
    ...(params.referenceExternalTransactionId ? { referenceExternalTransactionId: params.referenceExternalTransactionId } : {}),
  };
}

async function submit(appUrl: string, key: string, requestBody: ReturnType<typeof body>) {
  const response = await fetch(`${appUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(requestBody),
  });
  return { httpStatus: response.status, body: await response.json() as {
    transactionId: string; status: string; balance: { amount: string; currency: string };
    failureCode?: string;
  } };
}

test('refund credits a processed bet once and rejects a second reversal', async () => {
  await waitForApps(appUrls);
  const wallet = await createWallet('100.00');
  const bet = body({ walletId: wallet.id, playerId: wallet.playerId, externalTransactionId: `ref-bet-${uuidv7()}`, roundId: 'ref-round-1', kind: 'BET', amount: '20.00' });
  const betResult = await submit(appUrls[0], `reference-test:bet-${uuidv7()}`, bet);
  expect(betResult.body.status).toBe('PROCESSED');

  const refund = body({ walletId: wallet.id, playerId: wallet.playerId, externalTransactionId: `ref-refund-${uuidv7()}`, roundId: 'ref-round-1', kind: 'REFUND', amount: '20.00', referenceExternalTransactionId: bet.externalTransactionId });
  const refundResult = await submit(appUrls[1], `reference-test:refund-${uuidv7()}`, refund);
  expect(refundResult.body.status).toBe('PROCESSED');
  expect(refundResult.body.balance.amount).toBe('100.00');

  const secondRefund = body({ walletId: wallet.id, playerId: wallet.playerId, externalTransactionId: `ref-refund-${uuidv7()}`, roundId: 'ref-round-1', kind: 'REFUND', amount: '20.00', referenceExternalTransactionId: bet.externalTransactionId });
  const duplicate = await submit(appUrls[2], `reference-test:refund-${uuidv7()}`, secondRefund);
  expect(duplicate.httpStatus).toBe(422);
  expect(duplicate.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');

  const walletState = await fetch(`${appUrls[0]}/wallets/${wallet.id}`).then((response) => response.json()) as { balance: { amount: string }; version: number };
  expect(walletState.balance.amount).toBe('100.00');
  expect(walletState.version).toBe(3);
});

test('refund received before its bet stays pending, then resolves atomically', async () => {
  await waitForApps(appUrls);
  const wallet = await createWallet('100.00');
  const betExternalId = `future-bet-${uuidv7()}`;
  const refund = body({ walletId: wallet.id, playerId: wallet.playerId, externalTransactionId: `early-refund-${uuidv7()}`, roundId: 'future-round', kind: 'REFUND', amount: '20.00', referenceExternalTransactionId: betExternalId });

  const pending = await submit(appUrls[1], `reference-test:early-refund:${uuidv7()}`, refund);
  expect(pending.httpStatus).toBe(202);
  expect(pending.body.status).toBe('PENDING_REFERENCE');
  expect(pending.body.balance.amount).toBe('100.00');

  const bet = body({ walletId: wallet.id, playerId: wallet.playerId, externalTransactionId: betExternalId, roundId: 'future-round', kind: 'BET', amount: '20.00' });
  const betResult = await submit(appUrls[2], `reference-test:future-bet:${uuidv7()}`, bet);
  expect(betResult.body.status).toBe('PROCESSED');

  const deadline = Date.now() + 5_000;
  let state: { balance: { amount: string }; version: number } | undefined;
  while (Date.now() < deadline) {
    state = await fetch(`${appUrls[0]}/wallets/${wallet.id}`).then((response) => response.json()) as typeof state;
    if (state?.balance.amount === '100.00' && state.version === 3) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(state?.balance.amount).toBe('100.00');
  expect(state?.version).toBe(3);
});

test('rollback reverses a refund by debiting and rejects a rollback that would make balance negative', async () => {
  await waitForApps(appUrls);
  const wallet = await createWallet('100.00');
  const bet = body({ walletId: wallet.id, playerId: wallet.playerId, externalTransactionId: `rollback-bet-${uuidv7()}`, roundId: 'rollback-round', kind: 'BET', amount: '20.00' });
  expect((await submit(appUrls[0], `rollback:bet:${uuidv7()}`, bet)).body.status).toBe('PROCESSED');

  const refund = body({ walletId: wallet.id, playerId: wallet.playerId, externalTransactionId: `rollback-refund-${uuidv7()}`, roundId: 'rollback-round', kind: 'REFUND', amount: '20.00', referenceExternalTransactionId: bet.externalTransactionId });
  expect((await submit(appUrls[1], `rollback:refund:${uuidv7()}`, refund)).body.status).toBe('PROCESSED');

  const rollback = body({ walletId: wallet.id, playerId: wallet.playerId, externalTransactionId: `rollback-of-refund-${uuidv7()}`, roundId: 'rollback-round', kind: 'ROLLBACK', amount: '20.00', referenceExternalTransactionId: refund.externalTransactionId });
  const rollbackResult = await submit(appUrls[2], `rollback:reverse-refund:${uuidv7()}`, rollback);
  expect(rollbackResult.body.status).toBe('PROCESSED');
  expect(rollbackResult.body.balance.amount).toBe('80.00');

  const lowWallet = await createWallet('10.00');
  const win = body({ walletId: lowWallet.id, playerId: lowWallet.playerId, externalTransactionId: `rollback-win-${uuidv7()}`, roundId: 'negative-rollback-round', kind: 'WIN', amount: '10.00' });
  expect((await submit(appUrls[0], `rollback:win:${uuidv7()}`, win)).body.status).toBe('PROCESSED');
  const drain = body({ walletId: lowWallet.id, playerId: lowWallet.playerId, externalTransactionId: `rollback-drain-${uuidv7()}`, roundId: 'negative-rollback-round', kind: 'BET', amount: '20.00' });
  expect((await submit(appUrls[1], `rollback:drain:${uuidv7()}`, drain)).body.status).toBe('PROCESSED');

  const impossibleRollback = body({ walletId: lowWallet.id, playerId: lowWallet.playerId, externalTransactionId: `rollback-impossible-${uuidv7()}`, roundId: 'negative-rollback-round', kind: 'ROLLBACK', amount: '10.00', referenceExternalTransactionId: win.externalTransactionId });
  const rejected = await submit(appUrls[2], `rollback:impossible:${uuidv7()}`, impossibleRollback);
  expect(rejected.httpStatus).toBe(422);
  expect(rejected.body.status).toBe('REJECTED');
  expect(rejected.body.failureCode).toBe('REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE');
  const finalWallet = await fetch(`${appUrls[0]}/wallets/${lowWallet.id}`).then((response) => response.json()) as { balance: { amount: string }; version: number };
  expect(finalWallet.balance.amount).toBe('0.00');
  expect(finalWallet.version).toBe(3);
});
