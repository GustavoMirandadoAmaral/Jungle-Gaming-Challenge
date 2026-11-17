import { EntityManager } from '@mikro-orm/postgresql';
import { TransactionNotFoundError } from '../../shared/domain/errors/domain-error.js';
import { Money } from '../../shared/domain/value-objects/money.js';
import { WagerTransaction } from '../domain/entities/wager-transaction.entity.js';
import { WagerTransactionKind } from '../domain/enums/wager-transaction-kind.enum.js';
import { WagerTransactionStatus } from '../domain/enums/wager-transaction-status.enum.js';

export class GetWagerTransaction {
  constructor(private readonly em: EntityManager) {}

  async byId(id: string) {
    const rows = await this.em.getConnection().execute<any[]>(
      `select id, provider_id as "providerId", external_transaction_id as "externalTransactionId",
              player_id as "playerId", wallet_id as "walletId", round_id as "roundId", game_id as "gameId",
              kind, amount::text, currency, reference_external_transaction_id as "referenceExternalTransactionId",
              reference_transaction_id as "referenceTransactionId", status, failure_code as "failureCode",
              idempotency_key as "idempotencyKey", payload_hash as "payloadHash",
              resulting_balance::text as "resultingBalance", created_at as "createdAt", updated_at as "updatedAt", processed_at as "processedAt"
       from wager_transaction where id = ?`,
      [id],
    );
    return this.toResponse(rows[0], id);
  }

  async byExternal(providerId: string, externalTransactionId: string) {
    const rows = await this.em.getConnection().execute<any[]>(
      `select id, provider_id as "providerId", external_transaction_id as "externalTransactionId",
              player_id as "playerId", wallet_id as "walletId", round_id as "roundId", game_id as "gameId",
              kind, amount::text, currency, reference_external_transaction_id as "referenceExternalTransactionId",
              reference_transaction_id as "referenceTransactionId", status, failure_code as "failureCode",
              idempotency_key as "idempotencyKey", payload_hash as "payloadHash",
              resulting_balance::text as "resultingBalance", created_at as "createdAt", updated_at as "updatedAt", processed_at as "processedAt"
       from wager_transaction where provider_id = ? and external_transaction_id = ?`,
      [providerId, externalTransactionId],
    );
    return this.toResponse(rows[0], `${providerId}/${externalTransactionId}`);
  }

  private toResponse(row: any, identifier: string) {
    if (!row) throw new TransactionNotFoundError(identifier);
    const state = WagerTransaction.rehydrate({
      id: row.id,
      providerId: row.providerId,
      externalTransactionId: row.externalTransactionId,
      playerId: row.playerId,
      walletId: row.walletId,
      roundId: row.roundId,
      gameId: row.gameId,
      kind: row.kind as WagerTransactionKind,
      money: String(row.amount),
      currency: row.currency,
      status: row.status as WagerTransactionStatus,
      referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
      referenceTransactionId: row.referenceTransactionId ?? undefined,
      idempotencyKey: row.idempotencyKey,
      payloadHash: row.payloadHash,
      failureCode: row.failureCode ?? undefined,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    });
    return {
      id: state.id,
      providerId: state.providerId,
      externalTransactionId: state.externalTransactionId,
      playerId: state.playerId,
      walletId: state.walletId,
      roundId: state.roundId,
      gameId: state.gameId,
      kind: state.kind,
      money: state.money.toJSON(),
      status: state.status,
      referenceExternalTransactionId: state.referenceExternalTransactionId,
      referenceTransactionId: state.referenceTransactionId,
      failureCode: state.failureCode,
      resultingBalance: Money.from({ amount: String(row.resultingBalance), currency: row.currency }).toJSON(),
      createdAt: state.createdAt.toISOString(),
      updatedAt: state.updatedAt.toISOString(),
      processedAt: row.processedAt ? new Date(row.processedAt).toISOString() : undefined,
    };
  }
}
