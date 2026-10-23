import type { Lease } from '../core/run.js';
import type { Queryable } from '../db/pool.js';

export interface EffectKey {
  runId: string;
  stepIndex: number;
  effectKey: string;
}

const keyParams = (k: EffectKey) => [k.runId, k.stepIndex, k.effectKey];

/** The platform message id if this effect was already sent. */
export async function findSent(q: Queryable, key: EffectKey): Promise<string | null> {
  const { rows } = await q.query<{ external_message_id: string }>(
    `SELECT external_message_id FROM step_executions
     WHERE run_id = $1 AND step_index = $2 AND effect_key = $3 AND status = 'sent'`,
    keyParams(key),
  );
  return rows[0]?.external_message_id ?? null;
}

/** Records a new attempt as pending. Returns its attempt number, or null if the lease was lost. */
export async function markPending(q: Queryable, lease: Lease, key: EffectKey, now: Date): Promise<number | null> {
  const { rows } = await q.query<{ attempt: number }>(
    `INSERT INTO step_executions (run_id, step_index, effect_key, attempt, status, created_at, updated_at)
     SELECT $1, $2, $3, 1, 'pending', $5, $5
     FROM runs WHERE id = $1 AND lease_until = $4
     ON CONFLICT (run_id, step_index, effect_key) DO UPDATE
       SET attempt = step_executions.attempt + 1, status = 'pending', error = NULL, updated_at = $5
     RETURNING attempt`,
    [...keyParams(key), lease.until, now],
  );
  return rows[0]?.attempt ?? null;
}

export async function markSent(q: Queryable, key: EffectKey, attempt: number, messageId: string, now: Date) {
  await q.query(
    `UPDATE step_executions SET status = 'sent', external_message_id = $5, updated_at = $6
     WHERE run_id = $1 AND step_index = $2 AND effect_key = $3 AND attempt = $4`,
    [...keyParams(key), attempt, messageId, now],
  );
}

export async function markFailed(q: Queryable, key: EffectKey, attempt: number, error: string, now: Date) {
  await q.query(
    `UPDATE step_executions SET status = 'failed', error = $5, updated_at = $6
     WHERE run_id = $1 AND step_index = $2 AND effect_key = $3 AND attempt = $4`,
    [...keyParams(key), attempt, error, now],
  );
}
