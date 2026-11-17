import Decimal from 'decimal.js';
import { CurrencyMismatchError, DomainError } from '../errors/domain-error.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    const { amount, currency } = props;

    if (!amount || typeof amount !== 'string') {
      throw new DomainError('Money amount must be a non-empty string');
    }

    if (!currency || typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency)) {
      throw new DomainError('Currency must be a 3-letter ISO-4217 code');
    }

    if (!/^(?:0|[1-9]\d{0,17})\.\d{2}$/.test(amount)) {
      throw new DomainError('Money amount must be a non-negative decimal string with exactly 2 decimal places');
    }

    let decimal: Decimal;
    try {
      decimal = new Decimal(amount);
    } catch {
      throw new DomainError(`Invalid money amount: ${amount}`);
    }

    if (!decimal.isFinite()) {
      throw new DomainError(`Invalid money amount: ${amount}`);
    }

    return new Money(decimal, currency.toUpperCase());
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  private static fromDecimal(value: Decimal, currency: string): Money {
    if (!value.isFinite() || value.decimalPlaces() > 2 || value.abs().gte('1000000000000000000')) {
      throw new DomainError('Money arithmetic exceeded the supported numeric(20, 2) range');
    }
    return new Money(value, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromDecimal(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromDecimal(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.fromDecimal(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.equals(other.value);
  }

  getAmount(): string {
    return this.value.toFixed(2);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
