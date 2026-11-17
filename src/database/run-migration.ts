import { MikroORM } from '@mikro-orm/postgresql';
import config from '../mikro-orm.config';

async function runMigration() {
  const command = process.argv[2];

  if (!command || !['create', 'up', 'down'].includes(command)) {
    console.error('Usage: bun run src/database/run-migration.ts <create|up|down>');
    process.exit(1);
  }

  const orm = await MikroORM.init(config);
  const migrator = orm.getMigrator();

  try {
    switch (command) {
      case 'create': {
        const migration = await migrator.createMigration();
        console.log(`Created migration: ${migration.fileName}`);
        break;
      }
      case 'up': {
        const executed = await migrator.up();
        console.log(`Executed ${executed.length} migration(s):`);
        for (const m of executed) {
          console.log(`  - ${m.name}`);
        }
        break;
      }
      case 'down': {
        const executed = await migrator.down();
        console.log(`Reverted ${executed.length} migration(s):`);
        for (const m of executed) {
          console.log(`  - ${m.name}`);
        }
        break;
      }
    }
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await orm.close(true);
  }
}

runMigration();
