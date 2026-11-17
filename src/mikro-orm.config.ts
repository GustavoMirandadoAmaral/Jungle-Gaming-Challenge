import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { persistenceEntities } from './database/entities.js';

export default defineConfig({
  host: process.env.DATABASE_HOST || 'localhost',
  port: Number(process.env.DATABASE_PORT) || 5432,
  dbName: process.env.DATABASE_NAME || 'jungle_gaming',
  user: process.env.DATABASE_USER || 'jungle',
  password: process.env.DATABASE_PASSWORD || 'jungle_secret',
  entities: persistenceEntities,
  extensions: [Migrator],
  migrations: {
    path: './src/database/migrations',
    pathTs: './src/database/migrations',
    glob: '!(*.d).{js,ts}',
    transactional: true,
    allOrNothing: true,
  },
  debug: process.env.NODE_ENV === 'development',
  allowGlobalContext: false,
});
