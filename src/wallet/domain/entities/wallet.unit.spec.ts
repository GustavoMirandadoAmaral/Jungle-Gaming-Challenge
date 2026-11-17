import { expect, test } from 'bun:test';
import { CurrencyMismatchError, InsufficientBalanceError } from '../../../shared/domain/errors/domain-error.js';
import { Money } from '../../../shared/domain/value-objects/money.js';
import { Wallet } from './wallet.entity.js';

function openWallet() {
  return Wallet.open({
    playerId: 'player-unit-test',
    currency: 'BRL',
    initialBalance: Money.from({ amount: '50.00', currency: 'BRL' }),
  });
}

test('Wallet debit and credit update the balance and version exactly once per movement', () => {
  const wallet = openWallet();
  wallet.debit(Money.from({ amount: '20.00', currency: 'BRL' }));
  wallet.credit(Money.from({ amount: '5.00', currency: 'BRL' }));
  expect(wallet.balance.toJSON()).toEqual({ amount: '35.00', currency: 'BRL' });
  expect(wallet.version).toBe(3);
});

test('Wallet rejects an unaffordable debit without changing its state', () => {
  const wallet = openWallet();
  expect(() => wallet.debit(Money.from({ amount: '50.01', currency: 'BRL' }))).toThrow(InsufficientBalanceError);
  expect(wallet.balance.getAmount()).toBe('50.00');
  expect(wallet.version).toBe(1);
});

test('Wallet refuses negative movement and negative opening balances', () => {
  const negative = Money.from({ amount: '1.00', currency: 'BRL' }).negate();
  const wallet = openWallet();
  expect(() => wallet.credit(negative)).toThrow();
  expect(() => wallet.debit(negative)).toThrow();
  expect(() => Wallet.open({ playerId: 'negative-player', currency: 'BRL', initialBalance: negative })).toThrow();
  expect(wallet.balance.getAmount()).toBe('50.00');
  expect(wallet.version).toBe(1);
});

test('Wallet does not advance its version for a zero movement', () => {
  const wallet = openWallet();
  const zero = Money.zero('BRL');
  wallet.debit(zero);
  wallet.credit(zero);
  expect(wallet.balance.getAmount()).toBe('50.00');
  expect(wallet.version).toBe(1);
});

test('Wallet rejects a movement in a different currency', () => {
  const wallet = openWallet();
  expect(() => wallet.credit(Money.from({ amount: '1.00', currency: 'USD' }))).toThrow(CurrencyMismatchError);
  expect(wallet.balance.getAmount()).toBe('50.00');
  expect(wallet.version).toBe(1);
});
