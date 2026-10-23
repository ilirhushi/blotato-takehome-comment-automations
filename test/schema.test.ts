import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { createTestDb, type TestDb } from './helpers.js';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.truncate();
});

async function seedVersion() {
  const { rows: [automation] } = await t.db.query(
    `INSERT INTO automations (account_id, platform) VALUES ('acct', 'instagram') RETURNING id`,
  );
  const { rows: [version] } = await t.db.query(
    `INSERT INTO automation_versions (automation_id, trigger, steps)
     VALUES ($1, '{}', '[]') RETURNING id`,
    [automation.id],
  );
  return { automationId: automation.id as string, versionId: version.id as string };
}

async function seedEvent(platformEventId: string, contactId = 'contact-1') {
  const { rows: [event] } = await t.db.query(
    `INSERT INTO inbound_events (platform, platform_event_id, account_id, contact_id, kind, payload, received_at)
     VALUES ('instagram', $1, 'acct', $2, 'comment', '{}', now()) RETURNING id`,
    [platformEventId, contactId],
  );
  return event.id as string;
}

function insertRun(automationId: string, versionId: string, eventId: string, status: string) {
  return t.db.query(
    `INSERT INTO runs (automation_id, automation_version_id, account_id, platform, contact_id,
                       trigger_event_id, status)
     VALUES ($1, $2, 'acct', 'instagram', 'contact-1', $3, $4)`,
    [automationId, versionId, eventId, status],
  );
}

describe('schema', () => {
  it('is idempotent to migrate twice', async () => {
    expect(await migrate(t.db)).toEqual([]);
  });

  it('rejects duplicate inbound events per platform', async () => {
    await seedEvent('evt-1');
    await expect(seedEvent('evt-1')).rejects.toThrow(/duplicate key/);
  });

  it('rejects updates to automation versions', async () => {
    const { versionId } = await seedVersion();
    await expect(
      t.db.query(`UPDATE automation_versions SET steps = '[{}]' WHERE id = $1`, [versionId]),
    ).rejects.toThrow(/immutable/);
  });

  it('allows only one active run per contact, across running and waiting', async () => {
    const { automationId, versionId } = await seedVersion();
    await insertRun(automationId, versionId, await seedEvent('evt-1'), 'running');
    await expect(
      insertRun(automationId, versionId, await seedEvent('evt-2'), 'waiting'),
    ).rejects.toThrow(/runs_one_active_per_contact/);
    // Terminal runs do not count.
    await insertRun(automationId, versionId, await seedEvent('evt-3'), 'skipped');
  });

  it('allows several side effects per step, keyed by effect_key', async () => {
    const { automationId, versionId } = await seedVersion();
    await insertRun(automationId, versionId, await seedEvent('evt-1'), 'running');
    const { rows: [run] } = await t.db.query(`SELECT id FROM runs`);
    const insert = (key: string) =>
      t.db.query(
        `INSERT INTO step_executions (run_id, step_index, effect_key, status) VALUES ($1, 2, $2, 'pending')`,
        [run.id, key],
      );
    await insert('main');
    await insert('reprompt:1');
    await expect(insert('reprompt:1')).rejects.toThrow(/duplicate key/);
  });
});
