import { EntityManager } from '@mikro-orm/postgresql';

/** Execute raw SQL on the same database connection that owns the current transaction. */
export function executeInTransaction<T = any[]>(
  em: EntityManager,
  query: string,
  params: unknown[] = [],
): Promise<T> {
  const transaction = em.getTransactionContext();
  if (!transaction) {
    throw new Error('Raw SQL write attempted without an active MikroORM transaction');
  }
  return em.getConnection().execute(query, params, 'all', transaction) as Promise<T>;
}
