import { expect, test } from 'bun:test';
import { DomainError } from '../../../shared/domain/errors/domain-error.js';
import { Money } from '../../../shared/domain/value-objects/money.js';
import { LedgerDirection } from '../enums/ledger-direction.enum.js';
import { WalletLedgerEntry } from './wallet-ledger-entry.entity.js';

const props = {
  walletId: 'wallet-unit',
  transactionId: 'transaction-unit',
  direction: LedgerDirection.Credit,
  money: Money.from({ amount: '5.00', currency: 'BRL' }),
  balanceBefore: Money.from({ amount: '10.00', currency: 'BRL' }),
  balanceAfter: Money.from({ amount: '15.00', currency: 'BRL' }),
  walletVersion: 2,
};

test('ledger entry checks arithmetic and preserves immutable audit values', () => {
  const entry = WalletLedgerEntry.create(props);
  expect(entry.isBalanced()).toBe(true);
  expect(entry.toState()).toMatchObject({ direction: LedgerDirection.Credit, money: '5.00', balanceBefore: '10.00', balanceAfter: '15.00', walletVersion: 2 });
});

test('ledger entry rejects mismatched arithmetic, non-positive amounts, and invalid versions', () => {
  expect(() => WalletLedgerEntry.create({ ...props, balanceAfter: Money.from({ amount: '14.00', currency: 'BRL' }) })).toThrow(DomainError);
  expect(() => WalletLedgerEntry.create({ ...props, money: Money.zero('BRL'), balanceAfter: Money.from({ amount: '10.00', currency: 'BRL' }) })).toThrow(DomainError);
  expect(() => WalletLedgerEntry.create({ ...props, walletVersion: 0 })).toThrow(DomainError);
});
