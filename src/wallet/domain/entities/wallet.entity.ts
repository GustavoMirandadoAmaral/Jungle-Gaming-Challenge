import { v7 as uuidv7 } from 'uuid';
import {
  CurrencyMismatchError,
  DomainError,
  InsufficientBalanceError,
} from '../../../shared/domain/errors/domain-error.js';
import { Money } from '../../../shared/domain/value-objects/money.js';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  playerId: string;
  currency: string;
  initialBalance?: Money;
}

export class Wallet {
  private _id: string;
  private _playerId: string;
  private _currency: string;
  private _balance: Money;
  private _version: number;
  private _createdAt: Date;
  private _updatedAt: Date;

  private constructor(
    id: string,
    playerId: string,
    currency: string,
    balance: Money,
    version: number,
    createdAt: Date,
    updatedAt: Date,
  ) {
    this._id = id;
    this._playerId = playerId;
    this._currency = currency;
    this._balance = balance;
    this._version = version;
    this._createdAt = createdAt;
    this._updatedAt = updatedAt;
  }

  static open(props: OpenWalletProps): Wallet {
    const now = new Date();
    const currency = props.currency.toUpperCase();
    const initialBalance = props.initialBalance ?? Money.zero(currency);

    if (initialBalance.currency !== currency) {
      throw new CurrencyMismatchError(currency, initialBalance.currency);
    }
    if (initialBalance.isNegative()) {
      throw new DomainError('Initial wallet balance cannot be negative');
    }

    return new Wallet(
      uuidv7(),
      props.playerId,
      currency,
      initialBalance,
      1,
      now,
      now,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      Money.from({ amount: state.balance, currency: state.currency }),
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  debit(amount: Money): void {
    this.assertSameCurrency(amount);
    if (amount.isNegative()) throw new DomainError('Wallet debit amount cannot be negative');
    if (amount.isZero()) return;
    const newBalance = this._balance.subtract(amount);
    if (newBalance.isNegative()) {
      throw new InsufficientBalanceError(
        this._id,
        this._balance.getAmount(),
        amount.getAmount(),
      );
    }
    this._balance = newBalance;
    this._version += 1;
    this._updatedAt = new Date();
  }

  credit(amount: Money): void {
    this.assertSameCurrency(amount);
    if (amount.isNegative()) throw new DomainError('Wallet credit amount cannot be negative');
    if (amount.isZero()) return;
    this._balance = this._balance.add(amount);
    this._version += 1;
    this._updatedAt = new Date();
  }

  get id(): string {
    return this._id;
  }

  get playerId(): string {
    return this._playerId;
  }

  get currency(): string {
    return this._currency;
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return this._createdAt;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  toState(): WalletState {
    return {
      id: this._id,
      playerId: this._playerId,
      currency: this._currency,
      balance: this._balance.getAmount(),
      version: this._version,
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
    };
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this._currency) {
      throw new CurrencyMismatchError(this._currency, money.currency);
    }
  }
}
