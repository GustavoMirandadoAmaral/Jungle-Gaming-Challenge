import { expect, test } from 'bun:test';
import { v7 as uuidv7 } from 'uuid';
import { DomainError } from '../../../shared/domain/errors/domain-error.js';
import { Money } from '../../../shared/domain/value-objects/money.js';
import { LedgerDirection } from '../../../wallet/domain/enums/ledger-direction.enum.js';
import { WagerTransaction } from './wager-transaction.entity.js';
import { WagerTransactionKind } from '../enums/wager-transaction-kind.enum.js';
import { WagerTransactionStatus } from '../enums/wager-transaction-status.enum.js';

function create(kind: WagerTransactionKind, referenceExternalTransactionId?: string) {
  return WagerTransaction.create({
    providerId: 'unit-provider',
    externalTransactionId: `tx-${uuidv7()}`,
    playerId: 'unit-player',
    walletId: uuidv7(),
    roundId: 'unit-round',
    gameId: 'unit-game',
    kind,
    money: Money.from({ amount: '12.50', currency: 'BRL' }),
    referenceExternalTransactionId,
    idempotencyKey: uuidv7(),
  });
}

test('WagerTransaction models BET, WIN, and LOSS balance behavior', () => {
  const bet = create(WagerTransactionKind.Bet);
  const win = create(WagerTransactionKind.Win);
  const loss = create(WagerTransactionKind.Loss);
  expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
  expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  expect(loss.affectsBalance()).toBe(false);
  expect(loss.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
});

test('REFUND and ROLLBACK require a reference and reverse direction according to the source kind', () => {
  expect(() => create(WagerTransactionKind.Refund)).toThrow(DomainError);
  expect(() => create(WagerTransactionKind.Rollback)).toThrow(DomainError);

  const bet = create(WagerTransactionKind.Bet);
  const win = create(WagerTransactionKind.Win);
  const refund = create(WagerTransactionKind.Refund, 'source-bet');
  expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  expect(create(WagerTransactionKind.Rollback, 'bet').ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
  expect(create(WagerTransactionKind.Rollback, 'win').ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
  expect(create(WagerTransactionKind.Rollback, 'refund').ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
});

test('WagerTransaction rejects zero and negative monetary amounts', () => {
  const props = {
    providerId: 'unit-provider', externalTransactionId: 'invalid-amount-tx', playerId: 'unit-player',
    walletId: uuidv7(), roundId: 'unit-round', gameId: 'unit-game', kind: WagerTransactionKind.Bet,
    idempotencyKey: uuidv7(),
  };
  expect(() => WagerTransaction.create({ ...props, money: Money.zero('BRL') })).toThrow(DomainError);
  expect(() => WagerTransaction.create({ ...props, money: Money.from({ amount: '1.00', currency: 'BRL' }).negate() })).toThrow(DomainError);
});

test('WagerTransaction payload hash is stable for the same business payload and changes with amount', () => {
  const base = {
    externalTransactionId: 'external-unit-tx',
    providerId: 'unit-provider',
    playerId: 'unit-player',
    walletId: 'wallet-unit',
    roundId: 'unit-round',
    gameId: 'unit-game',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '12.50', currency: 'BRL' }).toJSON(),
  };
  const first = WagerTransaction.computePayloadHash(base);
  const retry = WagerTransaction.computePayloadHash({ ...base });
  const changed = WagerTransaction.computePayloadHash({ ...base, money: { amount: '12.51', currency: 'BRL' } });
  expect(first).toBe(retry);
  expect(first).not.toBe(changed);
});

test('processed wager transactions are terminal', () => {
  const wager = create(WagerTransactionKind.Bet);
  wager.markProcessed();
  expect(wager.status).toBe(WagerTransactionStatus.Processed);
  expect(wager.isTerminal()).toBe(true);
  expect(() => wager.reject('LATE_REJECTION')).toThrow(DomainError);
});

test('failed wager transactions are terminal and retain an auditable failure code', () => {
  const wager = create(WagerTransactionKind.Bet);
  wager.fail('PERMANENT_INFRASTRUCTURE_FAILURE');

  expect(wager.status).toBe(WagerTransactionStatus.Failed);
  expect(wager.failureCode).toBe('PERMANENT_INFRASTRUCTURE_FAILURE');
  expect(wager.isTerminal()).toBe(true);
  expect(() => wager.markProcessed()).toThrow(DomainError);
});
