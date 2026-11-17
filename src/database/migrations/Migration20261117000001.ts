import { Migration } from '@mikro-orm/migrations';

/** One successfully processed reversal per referenced transaction. */
export class Migration20261117000001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create unique index "wager_reference_reversal_uq"
      on "wager_transaction" ("reference_transaction_id", "kind")
      where "reference_transaction_id" is not null
        and "kind" in ('REFUND', 'ROLLBACK')
        and "status" = 'PROCESSED';`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "wager_reference_reversal_uq";`);
  }
}
