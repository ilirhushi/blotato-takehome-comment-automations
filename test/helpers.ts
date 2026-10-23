import { randomUUID } from 'node:crypto';
import { createPool, type Db } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

export interface TestDb {
  db: Db;
  truncate(): Promise<void>;
  close(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = createPool();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();

  const db = createPool({ searchPath: schema });
  await migrate(db);

  return {
    db,
    async truncate() {
      await db.query(
        `TRUNCATE automations, automation_versions, inbound_events, runs,
                  step_executions RESTART IDENTITY CASCADE`,
      );
    },
    async close() {
      await db.end();
      const cleanup = createPool();
      await cleanup.query(`DROP SCHEMA ${schema} CASCADE`);
      await cleanup.end();
    },
  };
}
