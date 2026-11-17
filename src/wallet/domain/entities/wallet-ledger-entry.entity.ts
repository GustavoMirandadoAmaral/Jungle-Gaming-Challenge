import { v7 as uuidv7 } from 'uuid';
import { DomainError } from '../../../shared/domain/errors/domain-error.js';
import { Money } from '../../../shared/domain/value-objects/money.js';
import { LedgerDirection } from '../enums/ledger-direction.enum.js';

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  walletVersion: number;
  createdAt: Date;
}

export interface CreateLedgerEntryProps {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number;
}

export class WalletLedgerEntry {
  private readonly _id: string;
  private readonly _walletId: string;
  private readonly _transactionId: string;
  private readonly _direction: LedgerDirection;
  private readonly _money: Money;
  private readonly _balanceBefore: Money;
  private readonly _balanceAfter: Money;
  private readonly _walletVersion: number;
  private readonly _createdAt: Date;

  private constructor(
    id: string,
    walletId: string,
    transactionId: string,
    direction: LedgerDirection,
    money: Money,
    balanceBefore: Money,
    balanceAfter: Money,
    walletVersion: number,
    createdAt: Date,
  ) {
    this._id = id;
    this._walletId = walletId;
    this._transactionId = transactionId;
    this._direction = direction;
    this._money = money;
    this._balanceBefore = balanceBefore;
    this._balanceAfter = balanceAfter;
    this._walletVersion = walletVersion;
    this._createdAt = createdAt;
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const { walletId, transactionId, direction, money, balanceBefore, balanceAfter, walletVersion } = props;

    if (!money.isPositive()) throw new DomainError('Ledger entry amount must be greater than zero');
    if (walletVersion < 1 || !Number.isInteger(walletVersion)) throw new DomainError('Ledger wallet version must be a positive integer');
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) throw new DomainError('Ledger balances cannot be negative');

    // Validate: balanceBefore ± money === balanceAfter
    let expectedAfter: Money;
    if (direction === LedgerDirection.Credit) {
      expectedAfter = balanceBefore.add(money);
    } else {
      expectedAfter = balanceBefore.subtract(money);
    }

    if (!expectedAfter.equals(balanceAfter)) {
      throw new DomainError(
        `Ledger entry balance mismatch: expected balanceAfter ${expectedAfter.getAmount()}, got ${balanceAfter.getAmount()}`,
      );
    }

    return new WalletLedgerEntry(
      uuidv7(),
      walletId,
      transactionId,
      direction,
      money,
      balanceBefore,
      balanceAfter,
      walletVersion,
      new Date(),
    );
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      Money.from({ amount: state.money, currency: state.currency }),
      Money.from({ amount: state.balanceBefore, currency: state.currency }),
      Money.from({ amount: state.balanceAfter, currency: state.currency }),
      state.walletVersion,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    let expectedAfter: Money;
    if (this._direction === LedgerDirection.Credit) {
      expectedAfter = this._balanceBefore.add(this._money);
    } else {
      expectedAfter = this._balanceBefore.subtract(this._money);
    }
    return expectedAfter.equals(this._balanceAfter);
  }

  get id(): string {
    return this._id;
  }

  get walletId(): string {
    return this._walletId;
  }

  get transactionId(): string {
    return this._transactionId;
  }

  get direction(): LedgerDirection {
    return this._direction;
  }

  get money(): Money {
    return this._money;
  }

  get balanceBefore(): Money {
    return this._balanceBefore;
  }

  get balanceAfter(): Money {
    return this._balanceAfter;
  }

  get walletVersion(): number {
    return this._walletVersion;
  }

  get createdAt(): Date {
    return this._createdAt;
  }

  toState(): LedgerEntryState {
    return {
      id: this._id,
      walletId: this._walletId,
      transactionId: this._transactionId,
      direction: this._direction,
      money: this._money.getAmount(),
      currency: this._money.currency,
      balanceBefore: this._balanceBefore.getAmount(),
      balanceAfter: this._balanceAfter.getAmount(),
      walletVersion: this._walletVersion,
      createdAt: this._createdAt,
    };
  }
}
