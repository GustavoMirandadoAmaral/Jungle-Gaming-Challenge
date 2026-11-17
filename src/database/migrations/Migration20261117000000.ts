import { Migration } from '@mikro-orm/migrations';

/**
 * Durable invariants for the financial core. Monetary values are PostgreSQL
 * numeric, and every balance-changing transaction can produce at most one
 * immutable ledger entry.
 */
export class Migration20261117000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table "wallet" (
      "id" uuid primary key,
      "player_id" varchar(160) not null,
      "currency" char(3) not null,
      "balance" numeric(20, 2) not null default 0,
      "version" integer not null default 1,
      "created_at" timestamptz not null default now(),
      "updated_at" timestamptz not null default now(),
      constraint "wallet_player_currency_uq" unique ("player_id", "currency"),
      constraint "wallet_balance_nonnegative_ck" check ("balance" >= 0),
      constraint "wallet_version_positive_ck" check ("version" >= 1)
    );`);

    this.addSql(`create table "wager_transaction" (
      "id" uuid primary key,
      "provider_id" varchar(160) not null,
      "external_transaction_id" varchar(200) not null,
      "idempotency_key" varchar(300) not null,
      "payload_hash" char(64) not null,
      "wallet_id" uuid not null references "wallet" ("id"),
      "player_id" varchar(160) not null,
      "round_id" varchar(200) not null,
      "game_id" varchar(200) not null,
      "kind" varchar(16) not null,
      "amount" numeric(20, 2) not null,
      "currency" char(3) not null,
      "reference_external_transaction_id" varchar(200),
      "reference_transaction_id" uuid references "wager_transaction" ("id"),
      "status" varchar(24) not null default 'PENDING',
      "failure_code" varchar(80),
      "resulting_balance" numeric(20, 2) not null,
      "processed_at" timestamptz,
      "created_at" timestamptz not null default now(),
      "updated_at" timestamptz not null default now(),
      constraint "wager_provider_external_uq" unique ("provider_id", "external_transaction_id"),
      constraint "wager_provider_idempotency_uq" unique ("provider_id", "idempotency_key"),
      constraint "wager_amount_nonnegative_ck" check ("amount" >= 0),
      constraint "wager_kind_ck" check ("kind" in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
      constraint "wager_status_ck" check ("status" in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
      constraint "wager_reference_required_ck" check (("kind" in ('REFUND','ROLLBACK')) = ("reference_external_transaction_id" is not null))
    );`);

    this.addSql(`create index "wager_wallet_created_idx" on "wager_transaction" ("wallet_id", "created_at", "id");`);

    this.addSql(`create table "wallet_ledger_entry" (
      "id" uuid primary key,
      "wallet_id" uuid not null references "wallet" ("id"),
      "transaction_id" uuid not null unique references "wager_transaction" ("id"),
      "direction" varchar(6) not null,
      "amount" numeric(20, 2) not null,
      "currency" char(3) not null,
      "balance_before" numeric(20, 2) not null,
      "balance_after" numeric(20, 2) not null,
      "wallet_version" integer not null,
      "created_at" timestamptz not null default now(),
      constraint "ledger_direction_ck" check ("direction" in ('CREDIT','DEBIT')),
      constraint "ledger_amount_positive_ck" check ("amount" > 0),
      constraint "ledger_balances_nonnegative_ck" check ("balance_before" >= 0 and "balance_after" >= 0),
      constraint "ledger_version_positive_ck" check ("wallet_version" >= 1),
      constraint "ledger_balance_math_ck" check (
        ("direction" = 'CREDIT' and "balance_after" = "balance_before" + "amount") or
        ("direction" = 'DEBIT' and "balance_after" = "balance_before" - "amount")
      )
    );`);
    this.addSql(`create index "ledger_wallet_cursor_idx" on "wallet_ledger_entry" ("wallet_id", "created_at" desc, "id" desc);`);

    this.addSql(`create table "inbox_message" (
      "id" uuid primary key,
      "consumer_name" varchar(160) not null,
      "message_id" varchar(200) not null,
      "processed_at" timestamptz not null default now(),
      constraint "inbox_consumer_message_uq" unique ("consumer_name", "message_id")
    );`);

    this.addSql(`create table "outbox_message" (
      "id" uuid primary key,
      "event_id" uuid not null unique,
      "event_type" varchar(160) not null,
      "aggregate_id" uuid not null,
      "payload" jsonb not null,
      "occurred_at" timestamptz not null,
      "published_at" timestamptz,
      "locked_until" timestamptz,
      "attempts" integer not null default 0,
      "created_at" timestamptz not null default now(),
      constraint "outbox_attempts_nonnegative_ck" check ("attempts" >= 0)
    );`);
    this.addSql(`create index "outbox_pending_idx" on "outbox_message" ("created_at", "id") where "published_at" is null;`);

    // Ledger rows are audit records: even privileged application code cannot
    // accidentally edit or remove them through normal SQL statements.
    this.addSql(`create function reject_ledger_mutation() returns trigger language plpgsql as $$
      begin raise exception 'wallet ledger entries are immutable'; end;
    $$;`);
    this.addSql(`create trigger "wallet_ledger_immutable_trg"
      before update or delete on "wallet_ledger_entry"
      for each row execute function reject_ledger_mutation();`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop trigger if exists "wallet_ledger_immutable_trg" on "wallet_ledger_entry";`);
    this.addSql(`drop function if exists reject_ledger_mutation();`);
    this.addSql(`drop table if exists "outbox_message";`);
    this.addSql(`drop table if exists "inbox_message";`);
    this.addSql(`drop table if exists "wallet_ledger_entry";`);
    this.addSql(`drop table if exists "wager_transaction";`);
    this.addSql(`drop table if exists "wallet";`);
  }
}
