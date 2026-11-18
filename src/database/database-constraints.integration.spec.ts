import { expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { v7 as uuidv7 } from 'uuid';
import mikroOrmConfig from '../mikro-orm.config.js';
import { executeInTransaction } from './execute-in-transaction.js';
import { waitForApps } from '../test-utils/wait-for-apps.js';

const appUrl = process.env.TEST_APP_URL ?? 'http://localhost:3001';
const requiredMigrations = [
  'Migration20261117000000',
  'Migration20261117000001',
  'Migration20261117000002',
];

async function expectSqlConstraintFailure(
  orm: MikroORM,
  sql: string,
  params: unknown[],
  expectedPostgresCode: string,
): Promise<void> {
  let actualPostgresCode: string | undefined;
  try {
    await orm.em.transactional((tx) => executeInTransaction(tx, sql, params));
  } catch (error) {
    actualPostgresCode = (error as { code?: string }).code;
  }
  expect(actualPostgresCode).toBe(expectedPostgresCode);
}

test('applied migrations and PostgreSQL constraints protect wallet and immutable ledger data', async () => {
  await waitForApps([appUrl]);
  const orm = await MikroORM.init(mikroOrmConfig);

  try {
    const migrationRows = await orm.em.getConnection().execute<any[]>(
      `select name from mikro_orm_migrations where name in (?, ?, ?) order by name`,
      requiredMigrations,
    );
    expect(migrationRows.map((row) => row.name).sort()).toEqual([...requiredMigrations].sort());

    const playerId = uuidv7();
    const createWallet = await fetch(`${appUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount: '20.00', currency: 'BRL' } }),
    });
    expect(createWallet.status).toBe(201);
    const wallet = await createWallet.json() as { id: string };
    const ledgerRows = await orm.em.getConnection().execute<any[]>(
      'select id, transaction_id from wallet_ledger_entry where wallet_id = ?',
      [wallet.id],
    );
    expect(ledgerRows).toHaveLength(1);

    // These statements go directly to PostgreSQL; application/domain guards
    // cannot intercept them. Each failed statement rolls back its own SQL tx.
    await expectSqlConstraintFailure(
      orm,
      'update wallet set balance = -1.00 where id = ?',
      [wallet.id],
      '23514',
    );
    await expectSqlConstraintFailure(
      orm,
      `insert into wallet (id, player_id, currency, balance, version)
       values (?, ?, 'BRL', 0.00, 1)`,
      [uuidv7(), playerId],
      '23505',
    );
    await expectSqlConstraintFailure(
      orm,
      'update wallet_ledger_entry set amount = 19.00 where id = ?',
      [ledgerRows[0].id],
      'P0001',
    );
    await expectSqlConstraintFailure(
      orm,
      'delete from wallet_ledger_entry where id = ?',
      [ledgerRows[0].id],
      'P0001',
    );
    await expectSqlConstraintFailure(
      orm,
      `insert into wallet_ledger_entry
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version)
       values (?, ?, ?, 'CREDIT', 20.00, 'BRL', 0.00, 20.00, 1)`,
      [uuidv7(), wallet.id, ledgerRows[0].transaction_id],
      '23505',
    );

    const persisted = await orm.em.getConnection().execute<any[]>(
      `select wallet.balance::text as balance, wallet.version,
              count(ledger.id)::int as ledger_count
       from wallet left join wallet_ledger_entry as ledger on ledger.wallet_id = wallet.id
       where wallet.id = ? group by wallet.id`,
      [wallet.id],
    );
    expect(persisted[0].balance).toBe('20.00');
    expect(Number(persisted[0].version)).toBe(1);
    expect(Number(persisted[0].ledger_count)).toBe(1);
  } finally {
    await orm.close(true);
  }
});
