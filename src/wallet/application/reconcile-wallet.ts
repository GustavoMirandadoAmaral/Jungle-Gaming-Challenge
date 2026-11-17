import { EntityManager } from '@mikro-orm/postgresql';
import { WalletNotFoundError } from '../../shared/domain/errors/domain-error.js';
import { Money } from '../../shared/domain/value-objects/money.js';

export class ReconcileWallet {
  constructor(private readonly em: EntityManager) {}

  async execute(walletId: string) {
    const rows = await this.em.getConnection().execute<any[]>(
      `select w.balance::text as "storedBalance", w.currency,
              coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20, 2)::text as "calculatedBalance",
              count(l.id)::text as "checkedEntries"
       from wallet w left join wallet_ledger_entry l on l.wallet_id = w.id
       where w.id = ? group by w.id`,
      [walletId],
    );
    const row = rows[0];
    if (!row) throw new WalletNotFoundError(walletId);

    const storedBalance = Money.from({ amount: String(row.storedBalance), currency: row.currency });
    const calculatedBalance = Money.from({ amount: String(row.calculatedBalance), currency: row.currency });
    const difference = storedBalance.subtract(calculatedBalance);
    const consistent = difference.isZero();
    const checkedEntries = Number.parseInt(String(row.checkedEntries), 10);
    if (!consistent) {
      // Do not put financial amounts in operational logs.
      console.error(JSON.stringify({ level: 'error', event: 'wallet_reconciliation_mismatch', walletId, checkedEntries }));
    }
    return {
      walletId,
      storedBalance: storedBalance.toJSON(),
      calculatedBalance: calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries,
    };
  }
}
