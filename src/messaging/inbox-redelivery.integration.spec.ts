import { expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { v7 as uuidv7 } from 'uuid';
import mikroOrmConfig from '../mikro-orm.config.js';
import { ProcessWagerTransaction, InboxMessageAlreadyProcessed } from '../wagering/application/process-wager-transaction.js';
import { WagerTransactionKind } from '../wagering/domain/enums/wager-transaction-kind.enum.js';
import { waitForApps } from '../test-utils/wait-for-apps.js';

const appUrl = process.env.TEST_APP_URL ?? 'http://localhost:3001';

test('a redelivered SQS messageId is stopped by the persistent inbox', async () => {
  await waitForApps([appUrl]);
  const playerId = uuidv7();
  const walletResponse = await fetch(`${appUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }),
  });
  expect(walletResponse.status).toBe(201);
  const wallet = await walletResponse.json() as { id: string };

  const externalTransactionId = `inbox-${uuidv7()}`;
  const input = {
    providerId: 'inbox-integration-test',
    externalTransactionId,
    idempotencyKey: `inbox-integration-test:${externalTransactionId}`,
    playerId,
    walletId: wallet.id,
    roundId: `round-${externalTransactionId}`,
    gameId: 'inbox-integration-test',
    kind: WagerTransactionKind.Bet,
    money: { amount: '10.00', currency: 'BRL' },
    inboxMessage: { consumerName: 'inbox-redelivery-integration-test', messageId: uuidv7() },
  };

  const orm = await MikroORM.init(mikroOrmConfig);
  try {
    const processWager = new ProcessWagerTransaction(orm.em.fork());
    const first = await processWager.execute(input);
    expect(first.status).toBe('PROCESSED');
    expect(first.balance).toEqual({ amount: '90.00', currency: 'BRL' });

    await expect(processWager.execute(input)).rejects.toBeInstanceOf(InboxMessageAlreadyProcessed);

    const walletAfterRedelivery = await fetch(`${appUrl}/wallets/${wallet.id}`);
    const state = await walletAfterRedelivery.json() as { balance: { amount: string }; version: number };
    expect(state.balance.amount).toBe('90.00');
    expect(state.version).toBe(2);
  } finally {
    await orm.close(true);
  }
}, 30_000);
