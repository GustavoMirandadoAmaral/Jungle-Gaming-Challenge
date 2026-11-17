import { BadRequestException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { WalletNotFoundError } from '../../shared/domain/errors/domain-error.js';
import { Wallet } from '../domain/entities/wallet.entity.js';
import { WalletLedgerEntry } from '../domain/entities/wallet-ledger-entry.entity.js';
import { LedgerDirection } from '../domain/enums/ledger-direction.enum.js';

interface LedgerCursor { createdAt: string; id: string }

export class GetWallet {
  constructor(private readonly em: EntityManager) {}

  async byId(walletId: string) {
    const rows = await this.em.getConnection().execute<any[]>(
      'select id, player_id as "playerId", currency, balance::text, version, created_at as "createdAt", updated_at as "updatedAt" from wallet where id = ?',
      [walletId],
    );
    const row = rows[0];
    if (!row) throw new WalletNotFoundError(walletId);
    const wallet = Wallet.rehydrate({
      id: row.id, playerId: row.playerId, currency: row.currency,
      balance: String(row.balance), version: row.version,
      createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt),
    });
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
    };
  }

  async ledger(walletId: string, cursor?: string, requestedLimit?: string) {
    // Verify the wallet exists even when it has no ledger entries.
    const walletRows = await this.em.getConnection().execute<any[]>(
      'select id from wallet where id = ?', [walletId],
    );
    if (!walletRows[0]) throw new WalletNotFoundError(walletId);

    const limit = this.parseLimit(requestedLimit);
    const decoded = cursor ? this.decodeCursor(cursor) : undefined;
    const rows = decoded
      ? await this.em.getConnection().execute<any[]>(
          `select id, wallet_id as "walletId", transaction_id as "transactionId", direction, amount::text, currency,
                  balance_before::text as "balanceBefore", balance_after::text as "balanceAfter",
                  wallet_version as "walletVersion", created_at as "createdAt"
           from wallet_ledger_entry where wallet_id = ? and (created_at, id) < (?, ?::uuid)
           order by created_at desc, id desc limit ?`,
          [walletId, new Date(decoded.createdAt), decoded.id, limit + 1],
        )
      : await this.em.getConnection().execute<any[]>(
          `select id, wallet_id as "walletId", transaction_id as "transactionId", direction, amount::text, currency,
                  balance_before::text as "balanceBefore", balance_after::text as "balanceAfter",
                  wallet_version as "walletVersion", created_at as "createdAt"
           from wallet_ledger_entry where wallet_id = ?
           order by created_at desc, id desc limit ?`,
          [walletId, limit + 1],
        );

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const entries = page.map((row) => WalletLedgerEntry.rehydrate({
      id: row.id,
      walletId: row.walletId,
      transactionId: row.transactionId,
      direction: row.direction as LedgerDirection,
      money: String(row.amount),
      currency: row.currency,
      balanceBefore: String(row.balanceBefore),
      balanceAfter: String(row.balanceAfter),
      walletVersion: row.walletVersion,
      createdAt: new Date(row.createdAt),
    }));

    const last = page.at(-1);
    return {
      walletId,
      items: entries.map((entry) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: hasMore && last
        ? this.encodeCursor({ createdAt: new Date(last.createdAt).toISOString(), id: last.id })
        : null,
      limit,
    };
  }

  private parseLimit(raw?: string): number {
    if (raw === undefined) return 50;
    if (!/^\d+$/.test(raw)) throw new BadRequestException('limit must be a positive integer');
    const value = Number.parseInt(raw, 10);
    if (value < 1 || value > 100) throw new BadRequestException('limit must be between 1 and 100');
    return value;
  }

  private decodeCursor(raw: string): LedgerCursor {
    try {
      const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as LedgerCursor;
      if (!parsed || typeof parsed.createdAt !== 'string' || !Number.isFinite(Date.parse(parsed.createdAt)) ||
          typeof parsed.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(parsed.id)) throw new Error();
      return parsed;
    } catch {
      throw new BadRequestException('cursor is invalid');
    }
  }

  private encodeCursor(cursor: LedgerCursor): string {
    return Buffer.from(JSON.stringify(cursor)).toString('base64url');
  }
}
