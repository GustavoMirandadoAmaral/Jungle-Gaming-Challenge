import { createHash } from 'crypto';
import { v7 as uuidv7 } from 'uuid';
import { DomainError, InvalidTransactionStateError } from '../../../shared/domain/errors/domain-error.js';
import { Money, MoneyProps } from '../../../shared/domain/value-objects/money.js';
import { LedgerDirection } from '../../../wallet/domain/enums/ledger-direction.enum.js';
import { WagerTransactionKind } from '../enums/wager-transaction-kind.enum.js';
import { WagerTransactionStatus } from '../enums/wager-transaction-status.enum.js';

export interface CreateWagerTransactionProps {
  externalTransactionId: string;
  providerId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  idempotencyKey: string;
}

export interface WagerTransactionState {
  id: string;
  externalTransactionId: string;
  providerId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: string;
  currency: string;
  status: WagerTransactionStatus;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  idempotencyKey: string;
  payloadHash: string;
  failureCode?: string;
  createdAt: Date;
  updatedAt: Date;
}

const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

const KINDS_REQUIRING_REFERENCE: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

const KINDS_AFFECTING_BALANCE: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Opening,
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

export class WagerTransaction {
  private _id: string;
  private _externalTransactionId: string;
  private _providerId: string;
  private _playerId: string;
  private _walletId: string;
  private _roundId: string;
  private _gameId: string;
  private _kind: WagerTransactionKind;
  private _money: Money;
  private _status: WagerTransactionStatus;
  private _referenceExternalTransactionId?: string;
  private _referenceTransactionId?: string;
  private _idempotencyKey: string;
  private _payloadHash: string;
  private _failureCode?: string;
  private _createdAt: Date;
  private _updatedAt: Date;

  private constructor(
    id: string,
    externalTransactionId: string,
    providerId: string,
    playerId: string,
    walletId: string,
    roundId: string,
    gameId: string,
    kind: WagerTransactionKind,
    money: Money,
    status: WagerTransactionStatus,
    idempotencyKey: string,
    payloadHash: string,
    createdAt: Date,
    updatedAt: Date,
    referenceExternalTransactionId?: string,
    referenceTransactionId?: string,
    failureCode?: string,
  ) {
    this._id = id;
    this._externalTransactionId = externalTransactionId;
    this._providerId = providerId;
    this._playerId = playerId;
    this._walletId = walletId;
    this._roundId = roundId;
    this._gameId = gameId;
    this._kind = kind;
    this._money = money;
    this._status = status;
    this._idempotencyKey = idempotencyKey;
    this._payloadHash = payloadHash;
    this._createdAt = createdAt;
    this._updatedAt = updatedAt;
    this._referenceExternalTransactionId = referenceExternalTransactionId;
    this._referenceTransactionId = referenceTransactionId;
    this._failureCode = failureCode;
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const {
      externalTransactionId,
      providerId,
      playerId,
      walletId,
      roundId,
      gameId,
      kind,
      money,
      referenceExternalTransactionId,
      idempotencyKey,
    } = props;

    // Validate reference requirement
    if (KINDS_REQUIRING_REFERENCE.has(kind) && !referenceExternalTransactionId) {
      throw new DomainError(
        `${kind} transaction requires a reference transaction ID`,
      );
    }

    if (!KINDS_REQUIRING_REFERENCE.has(kind) && referenceExternalTransactionId) {
      throw new DomainError(
        `${kind} transaction must not have a reference transaction ID`,
      );
    }

    const now = new Date();
    const payloadHash = WagerTransaction.computePayloadHash({
      externalTransactionId,
      providerId,
      playerId,
      walletId,
      roundId,
      gameId,
      kind,
      money: money.toJSON(),
      referenceExternalTransactionId,
    });

    return new WagerTransaction(
      uuidv7(),
      externalTransactionId,
      providerId,
      playerId,
      walletId,
      roundId,
      gameId,
      kind,
      money,
      WagerTransactionStatus.Pending,
      idempotencyKey,
      payloadHash,
      now,
      now,
      referenceExternalTransactionId,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.externalTransactionId,
      state.providerId,
      state.playerId,
      state.walletId,
      state.roundId,
      state.gameId,
      state.kind,
      Money.from({ amount: state.money, currency: state.currency }),
      state.status,
      state.idempotencyKey,
      state.payloadHash,
      state.createdAt,
      state.updatedAt,
      state.referenceExternalTransactionId,
      state.referenceTransactionId,
      state.failureCode,
    );
  }

  markProcessed(referenceTransactionId?: string): void {
    this.assertNotTerminal('Processed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._updatedAt = new Date();
  }

  markPendingReference(): void {
    this.assertNotTerminal('PendingReference');
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(
        this._id,
        this._status,
        'PendingReference',
      );
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._updatedAt = new Date();
  }

  reject(failureCode: string): void {
    this.assertNotTerminal('Rejected');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = failureCode;
    this._updatedAt = new Date();
  }

  fail(failureCode: string): void {
    this.assertNotTerminal('Failed');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = failureCode;
    this._updatedAt = new Date();
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  affectsBalance(): boolean {
    // Loss does not affect balance (it's a no-op marker for round closure)
    return KINDS_AFFECTING_BALANCE.has(this._kind);
  }

  requiresReference(): boolean {
    return KINDS_REQUIRING_REFERENCE.has(this._kind);
  }

  matchesPayload(otherHash: string): boolean {
    return this._payloadHash === otherHash;
  }

  ledgerDirectionFor(): LedgerDirection {
    switch (this._kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Rollback:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Loss:
        // Loss doesn't affect balance, but if ever called, treat as no-op debit of zero
        return LedgerDirection.Debit;
      default: {
        const _exhaustive: never = this._kind;
        throw new DomainError(`Unknown transaction kind: ${_exhaustive}`);
      }
    }
  }

  static computePayloadHash(payload: {
    externalTransactionId: string;
    providerId: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: MoneyProps;
    referenceExternalTransactionId?: string;
  }): string {
    const canonical = JSON.stringify({
      externalTransactionId: payload.externalTransactionId,
      providerId: payload.providerId,
      playerId: payload.playerId,
      walletId: payload.walletId,
      roundId: payload.roundId,
      gameId: payload.gameId,
      kind: payload.kind,
      money: {
        amount: payload.money.amount,
        currency: payload.money.currency,
      },
      referenceExternalTransactionId: payload.referenceExternalTransactionId ?? null,
    });
    return createHash('sha256').update(canonical).digest('hex');
  }

  // Getters
  get id(): string {
    return this._id;
  }

  get externalTransactionId(): string {
    return this._externalTransactionId;
  }

  get providerId(): string {
    return this._providerId;
  }

  get playerId(): string {
    return this._playerId;
  }

  get walletId(): string {
    return this._walletId;
  }

  get roundId(): string {
    return this._roundId;
  }

  get gameId(): string {
    return this._gameId;
  }

  get kind(): WagerTransactionKind {
    return this._kind;
  }

  get money(): Money {
    return this._money;
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceExternalTransactionId(): string | undefined {
    return this._referenceExternalTransactionId;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get idempotencyKey(): string {
    return this._idempotencyKey;
  }

  get payloadHash(): string {
    return this._payloadHash;
  }

  get failureCode(): string | undefined {
    return this._failureCode;
  }

  get createdAt(): Date {
    return this._createdAt;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  toState(): WagerTransactionState {
    return {
      id: this._id,
      externalTransactionId: this._externalTransactionId,
      providerId: this._providerId,
      playerId: this._playerId,
      walletId: this._walletId,
      roundId: this._roundId,
      gameId: this._gameId,
      kind: this._kind,
      money: this._money.getAmount(),
      currency: this._money.currency,
      status: this._status,
      referenceExternalTransactionId: this._referenceExternalTransactionId,
      referenceTransactionId: this._referenceTransactionId,
      idempotencyKey: this._idempotencyKey,
      payloadHash: this._payloadHash,
      failureCode: this._failureCode,
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
    };
  }

  private assertNotTerminal(attemptedTransition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        this._id,
        this._status,
        attemptedTransition,
      );
    }
  }
}
