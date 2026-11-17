import { Migration } from '@mikro-orm/migrations';

export class Migration20261117000002 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table "wager_transaction"
      add column "pending_reference_attempts" integer not null default 0,
      add column "pending_reference_next_attempt_at" timestamptz not null default now(),
      add constraint "wager_pending_reference_attempts_ck" check ("pending_reference_attempts" >= 0);`);
    this.addSql(`create index "wager_pending_reference_due_idx"
      on "wager_transaction" ("pending_reference_next_attempt_at", "created_at", "id")
      where "status" = 'PENDING_REFERENCE';`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "wager_transaction" drop constraint if exists "wager_pending_reference_attempts_ck";`);
    this.addSql(`drop index if exists "wager_pending_reference_due_idx";`);
    this.addSql(`alter table "wager_transaction" drop column if exists "pending_reference_next_attempt_at";`);
    this.addSql(`alter table "wager_transaction" drop column if exists "pending_reference_attempts";`);
  }
}
