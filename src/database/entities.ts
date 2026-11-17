import { EntitySchema } from '@mikro-orm/core';
import { LedgerDirection } from '../wallet/domain/enums/ledger-direction.enum.js';
import { WagerTransactionKind } from '../wagering/domain/enums/wager-transaction-kind.enum.js';
import { WagerTransactionStatus } from '../wagering/domain/enums/wager-transaction-status.enum.js';

export class WalletRow { id!: string; playerId!: string; currency!: string; balance!: string; version!: number; createdAt!: Date; updatedAt!: Date }
export class WagerTransactionRow {
  id!: string; providerId!: string; externalTransactionId!: string; idempotencyKey!: string; payloadHash!: string;
  walletId!: string; playerId!: string; roundId!: string; gameId!: string; kind!: WagerTransactionKind;
  amount!: string; currency!: string; referenceExternalTransactionId?: string; referenceTransactionId?: string;
  status!: WagerTransactionStatus; failureCode?: string; resultingBalance!: string; processedAt?: Date; createdAt!: Date; updatedAt!: Date;
}
export class LedgerRow {
  id!: string; walletId!: string; transactionId!: string; direction!: LedgerDirection; amount!: string;
  currency!: string; balanceBefore!: string; balanceAfter!: string; walletVersion!: number; createdAt!: Date;
}
export class InboxRow { id!: string; consumerName!: string; messageId!: string; processedAt!: Date }
export class OutboxRow {
  id!: string; eventId!: string; eventType!: string; aggregateId!: string; payload!: unknown;
  occurredAt!: Date; publishedAt?: Date; lockedUntil?: Date; attempts!: number; createdAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRow>({ class: WalletRow, tableName: 'wallet', properties: {
  id: { type: 'uuid', primary: true }, playerId: { name: 'player_id', type: 'string', length: 160 },
  currency: { type: 'string', length: 3 }, balance: { type: 'decimal', precision: 20, scale: 2 },
  version: { type: 'integer' }, createdAt: { name: 'created_at', type: 'datetime' }, updatedAt: { name: 'updated_at', type: 'datetime' },
}});
export const WagerTransactionSchema = new EntitySchema<WagerTransactionRow>({ class: WagerTransactionRow, tableName: 'wager_transaction', properties: {
  id: { type: 'uuid', primary: true }, providerId: { name: 'provider_id', type: 'string', length: 160 },
  externalTransactionId: { name: 'external_transaction_id', type: 'string', length: 200 },
  idempotencyKey: { name: 'idempotency_key', type: 'string', length: 300 }, payloadHash: { name: 'payload_hash', type: 'string', length: 64 },
  walletId: { name: 'wallet_id', type: 'uuid' }, playerId: { name: 'player_id', type: 'string', length: 160 },
  roundId: { name: 'round_id', type: 'string', length: 200 }, gameId: { name: 'game_id', type: 'string', length: 200 },
  kind: { type: 'string', length: 16 }, amount: { type: 'decimal', precision: 20, scale: 2 }, currency: { type: 'string', length: 3 },
  referenceExternalTransactionId: { name: 'reference_external_transaction_id', type: 'string', length: 200, nullable: true },
  referenceTransactionId: { name: 'reference_transaction_id', type: 'uuid', nullable: true },
  status: { type: 'string', length: 24 }, failureCode: { name: 'failure_code', type: 'string', length: 80, nullable: true },
  resultingBalance: { name: 'resulting_balance', type: 'decimal', precision: 20, scale: 2 },
  processedAt: { name: 'processed_at', type: 'datetime', nullable: true }, createdAt: { name: 'created_at', type: 'datetime' }, updatedAt: { name: 'updated_at', type: 'datetime' },
}});
export const LedgerSchema = new EntitySchema<LedgerRow>({ class: LedgerRow, tableName: 'wallet_ledger_entry', properties: {
  id: { type: 'uuid', primary: true }, walletId: { name: 'wallet_id', type: 'uuid' }, transactionId: { name: 'transaction_id', type: 'uuid' },
  direction: { type: 'string', length: 6 }, amount: { type: 'decimal', precision: 20, scale: 2 }, currency: { type: 'string', length: 3 },
  balanceBefore: { name: 'balance_before', type: 'decimal', precision: 20, scale: 2 }, balanceAfter: { name: 'balance_after', type: 'decimal', precision: 20, scale: 2 },
  walletVersion: { name: 'wallet_version', type: 'integer' }, createdAt: { name: 'created_at', type: 'datetime' },
}});
export const InboxSchema = new EntitySchema<InboxRow>({ class: InboxRow, tableName: 'inbox_message', properties: {
  id: { type: 'uuid', primary: true }, consumerName: { name: 'consumer_name', type: 'string', length: 160 },
  messageId: { name: 'message_id', type: 'string', length: 200 }, processedAt: { name: 'processed_at', type: 'datetime' },
}});
export const OutboxSchema = new EntitySchema<OutboxRow>({ class: OutboxRow, tableName: 'outbox_message', properties: {
  id: { type: 'uuid', primary: true }, eventId: { name: 'event_id', type: 'uuid' }, eventType: { name: 'event_type', type: 'string', length: 160 },
  aggregateId: { name: 'aggregate_id', type: 'uuid' }, payload: { type: 'json' }, occurredAt: { name: 'occurred_at', type: 'datetime' },
  publishedAt: { name: 'published_at', type: 'datetime', nullable: true }, lockedUntil: { name: 'locked_until', type: 'datetime', nullable: true },
  attempts: { type: 'integer' }, createdAt: { name: 'created_at', type: 'datetime' },
}});

export const persistenceEntities = [WalletSchema, WagerTransactionSchema, LedgerSchema, InboxSchema, OutboxSchema];
