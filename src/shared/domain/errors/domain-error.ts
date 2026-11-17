import { FailureCode } from './failure-codes.js';

export class DomainError extends Error {
  public readonly code: string;

  constructor(message: string, code: string = 'DOMAIN_ERROR') {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, actual: string) {
    super(
      `Currency mismatch: expected ${expected}, got ${actual}`,
      FailureCode.CURRENCY_MISMATCH,
    );
  }
}

export class InsufficientBalanceError extends DomainError {
  constructor(walletId: string, available: string, required: string) {
    super(
      `Insufficient balance on wallet ${walletId}: available ${available}, required ${required}`,
      FailureCode.INSUFFICIENT_BALANCE,
    );
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(transactionId: string, currentState: string, attemptedTransition: string) {
    super(
      `Invalid state transition for transaction ${transactionId}: cannot transition from ${currentState} to ${attemptedTransition}`,
      FailureCode.INVALID_TRANSACTION_STATE,
    );
  }
}

export class DuplicateWalletError extends DomainError {
  constructor(playerId: string, currency: string) {
    super(
      `Wallet already exists for player ${playerId} with currency ${currency}`,
      FailureCode.DUPLICATE_WALLET,
    );
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor(idempotencyKey: string) {
    super(
      `Idempotency conflict: key ${idempotencyKey} has already been used with a different payload`,
      FailureCode.IDEMPOTENCY_CONFLICT,
    );
  }
}

export class TransactionNotFoundError extends DomainError {
  constructor(identifier: string) {
    super(
      `Transaction not found: ${identifier}`,
      FailureCode.REFERENCE_NOT_FOUND,
    );
  }
}

export class WalletNotFoundError extends DomainError {
  constructor(identifier: string) {
    super(
      `Wallet not found: ${identifier}`,
      'WALLET_NOT_FOUND',
    );
  }
}

export class InvalidReferenceError extends DomainError {
  constructor(message: string, code: FailureCode) {
    super(message, code);
  }
}

export class ReferenceAlreadyReversedError extends DomainError {
  constructor(referenceTransactionId: string) {
    super(
      `Reference transaction ${referenceTransactionId} has already been reversed`,
      FailureCode.REFERENCE_ALREADY_REVERSED,
    );
  }
}

export class NegativeBalanceError extends DomainError {
  constructor(walletId: string, resultingBalance: string) {
    super(
      `Operation would cause negative balance on wallet ${walletId}: resulting balance would be ${resultingBalance}`,
      FailureCode.REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE,
    );
  }
}
