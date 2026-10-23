import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = Db | Tx;

export const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@localhost:5433/automations';

export function createPool(opts: { connectionString?: string; searchPath?: string } = {}): Db {
  return new pg.Pool({
    connectionString: opts.connectionString ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    options: opts.searchPath ? `-c search_path=${opts.searchPath}` : undefined,
  });
}

export async function withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    const result = await fn(tx);
    await tx.query('COMMIT');
    return result;
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

/** Runs fn inside a savepoint, so its failure leaves the surrounding transaction usable. */
export async function withSavepoint<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  await tx.query('SAVEPOINT sp');
  try {
    const result = await fn();
    await tx.query('RELEASE SAVEPOINT sp');
    return result;
  } catch (err) {
    await tx.query('ROLLBACK TO SAVEPOINT sp');
    throw err;
  }
}
