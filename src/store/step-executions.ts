import type { Lease } from '../core/run.js';
import type { Queryable } from '../db/pool.js';

export interface EffectKey {
  runId: string;
  stepIndex: number;
  effectKey: string;
}

const keyParams = (k: EffectKey) => [k.runId, k.stepIndex, k.effectKey];

export type Channel = 'comment_reply' | 'dm' | 'private_reply';

export interface SentEffect {
  /** Null when delivery was inferred rather than confirmed by the platform. */
  messageId: string | null;
  channel: Channel;
}

/** How this effect was delivered, if it already was. */
export async function findSent(q: Queryable, key: EffectKey): Promise<SentEffect | null> {
  const { rows } = await q.query<{ external_message_id: string | null; channel: Channel }>(
    `SELECT external_message_id, channel FROM step_executions
     WHERE run_id = $1 AND step_index = $2 AND effect_key = $3 AND status = 'sent'`,
    keyParams(key),
  );
  return rows[0] ? { messageId: rows[0].external_message_id, channel: rows[0].channel } : null;
}

/** Records a new attempt as pending. Returns its attempt number, or null if the lease was lost. */
export async function markPending(
  q: Queryable,
  lease: Lease,
  key: EffectKey,
  channel: Channel,
  now: Date,
): Promise<number | null> {
  const { rows } = await q.query<{ attempt: number }>(
    `INSERT INTO step_executions (run_id, step_index, effect_key, attempt, attempted_at, channel, status, created_at, updated_at)
     SELECT $1, $2, $3, 1, $5, $6, 'pending', $5, $5
     FROM runs WHERE id = $1 AND lease_until = $4
     ON CONFLICT (run_id, step_index, effect_key) DO UPDATE
       SET attempt = step_executions.attempt + 1, attempted_at = $5, channel = $6, status = 'pending', error = NULL,
           updated_at = $5
     RETURNING attempt`,
    [...keyParams(key), lease.until, now, channel],
  );
  return rows[0]?.attempt ?? null;
}

export async function markSent(q: Queryable, key: EffectKey, attempt: number, messageId: string | null, now: Date) {
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

/** When the attempt that delivered the run's most recent side effect started. */
export async function latestSentAt(q: Queryable, runId: string): Promise<Date | null> {
  const { rows } = await q.query<{ at: Date | null }>(
    `SELECT max(attempted_at) AS at FROM step_executions WHERE run_id = $1 AND status = 'sent'`,
    [runId],
  );
  return rows[0]?.at ?? null;
}
