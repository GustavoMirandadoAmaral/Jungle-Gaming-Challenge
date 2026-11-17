import { expect, test } from 'bun:test';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { v7 as uuidv7 } from 'uuid';
import { waitForApps } from '../test-utils/wait-for-apps.js';

const appUrl = process.env.TEST_APP_URL ?? 'http://localhost:3001';
const queueUrl = process.env.TEST_SQS_WAGER_QUEUE_URL ?? 'http://localhost:4566/000000000000/wager-transactions.fifo';
const sqs = new SQSClient({
  endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
  region: process.env.SQS_REGION ?? 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

test('SQS consumer applies a wager through the use case and commits before ack', async () => {
  await waitForApps([appUrl]);
  const playerId = uuidv7();
  const walletResponse = await fetch(`${appUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } }),
  });
  expect(walletResponse.status).toBe(201);
  const wallet = await walletResponse.json() as { id: string };

  const externalTransactionId = `sqs-${uuidv7()}`;
  const idempotencyKey = `sqs-test:${externalTransactionId}`;
  const envelope = {
    messageId: uuidv7(),
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'sqs-test',
      externalTransactionId,
      idempotencyKey,
      playerId,
      walletId: wallet.id,
      roundId: `round-${externalTransactionId}`,
      gameId: 'sqs-integration-test',
      kind: 'BET',
      money: { amount: '50.00', currency: 'BRL' },
    },
  };

  await sqs.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(envelope),
    MessageGroupId: wallet.id,
    MessageDeduplicationId: envelope.messageId,
  }));

  const deadline = Date.now() + 15_000;
  let finalWallet: { balance: { amount: string; currency: string }; version: number } | undefined;
  while (Date.now() < deadline) {
    const response = await fetch(`${appUrl}/wallets/${wallet.id}`);
    if (response.ok) {
      finalWallet = await response.json() as typeof finalWallet;
      if (finalWallet?.balance.amount === '950.00') break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  expect(finalWallet?.balance).toEqual({ amount: '950.00', currency: 'BRL' });
  expect(finalWallet?.version).toBe(2);

  const ledgerResponse = await fetch(`${appUrl}/wallets/${wallet.id}/ledger`);
  expect(ledgerResponse.status).toBe(200);
  const ledger = await ledgerResponse.json() as {
    items: Array<{ direction: string; money: { amount: string } }>;
  };
  expect(ledger.items.filter((item) => item.direction === 'DEBIT' && item.money.amount === '50.00')).toHaveLength(1);
}, 30_000);
