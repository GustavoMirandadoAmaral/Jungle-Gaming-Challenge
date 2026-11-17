import { expect, test } from 'bun:test';
import { CurrencyMismatchError, DomainError } from '../errors/domain-error.js';
import { Money } from './money.js';

test('Money performs exact decimal arithmetic and always serializes with two decimal places', () => {
  const total = Money.from({ amount: '0.10', currency: 'brl' }).add(Money.from({ amount: '0.20', currency: 'BRL' }));
  expect(total.toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
  expect(total.subtract(Money.from({ amount: '0.50', currency: 'BRL' })).toJSON()).toEqual({ amount: '-0.20', currency: 'BRL' });
  expect(total.negate().toJSON()).toEqual({ amount: '-0.30', currency: 'BRL' });
});

test('Money rejects malformed, negative, scientific, and over-precision input', () => {
  for (const amount of ['', '-1.00', '+1.00', '01.00', '1', '1.0', '1.000', '1e2', 'NaN', 'Infinity']) {
    expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(DomainError);
  }
  expect(() => Money.from({ amount: '1.00', currency: 'R$1' })).toThrow(DomainError);
});

test('Money enforces currency equality for arithmetic and comparisons', () => {
  const brl = Money.from({ amount: '10.00', currency: 'BRL' });
  const usd = Money.from({ amount: '10.00', currency: 'USD' });
  expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
  expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
  expect(() => brl.equals(usd)).toThrow(CurrencyMismatchError);
});
