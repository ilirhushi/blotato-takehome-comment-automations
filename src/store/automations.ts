import type { CandidateAutomation } from '../core/planner.js';
import type { ContactKey, Platform, Step, Trigger } from '../core/types.js';
import type { Queryable } from '../db/pool.js';

export async function insertAutomation(q: Queryable, accountId: string, platform: Platform): Promise<string> {
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO automations (account_id, platform) VALUES ($1, $2) RETURNING id`,
    [accountId, platform],
  );
  return rows[0]!.id;
}

/** Inserts a version and makes it the automation's current one. */
export async function insertCurrentVersion(
  q: Queryable,
  automationId: string,
  trigger: Trigger,
  steps: Step[],
): Promise<string> {
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO automation_versions (automation_id, trigger, steps) VALUES ($1, $2, $3) RETURNING id`,
    [automationId, JSON.stringify(trigger), JSON.stringify(steps)],
  );
  const versionId = rows[0]!.id;
  await q.query(`UPDATE automations SET current_version_id = $2 WHERE id = $1`, [automationId, versionId]);
  return versionId;
}

export async function setEnabled(q: Queryable, automationId: string, enabled: boolean): Promise<void> {
  await q.query(`UPDATE automations SET enabled = $2 WHERE id = $1`, [automationId, enabled]);
}

/** Enabled automations for the contact's account, oldest first. */
export async function enabledForAccount(
  q: Queryable,
  contact: Pick<ContactKey, 'accountId' | 'platform'>,
): Promise<CandidateAutomation[]> {
  const { rows } = await q.query<{ automation_id: string; version_id: string; trigger: Trigger }>(
    `SELECT a.id AS automation_id, v.id AS version_id, v.trigger
     FROM automations a JOIN automation_versions v ON v.id = a.current_version_id
     WHERE a.account_id = $1 AND a.platform = $2 AND a.enabled
     ORDER BY a.created_at, a.id`,
    [contact.accountId, contact.platform],
  );
  return rows.map((r) => ({ automationId: r.automation_id, versionId: r.version_id, trigger: r.trigger }));
}

export async function stepsOfVersion(q: Queryable, versionId: string): Promise<Step[]> {
  const { rows } = await q.query<{ steps: Step[] }>(`SELECT steps FROM automation_versions WHERE id = $1`, [
    versionId,
  ]);
  return rows[0]!.steps;
}
