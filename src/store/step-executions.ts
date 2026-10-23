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
  /** True if this attempt, or an earlier one that may have been delivered, was a private reply. */
  privateReplyUsed: boolean;
}

const PRIVATE_REPLY_USED = `(channel = 'private_reply' OR uncertain_private_reply)`;

/** How this effect was delivered, if it already was. */
export async function findSent(q: Queryable, key: EffectKey): Promise<SentEffect | null> {
  const { rows } = await q.query<{ external_message_id: string | null; private_reply_used: boolean }>(
    `SELECT external_message_id, ${PRIVATE_REPLY_USED} AS private_reply_used FROM step_executions
     WHERE run_id = $1 AND step_index = $2 AND effect_key = $3 AND status = 'sent'`,
    keyParams(key),
  );
  return rows[0] ? { messageId: rows[0].external_message_id, privateReplyUsed: rows[0].private_reply_used } : null;
}

export interface PendingAttempt {
  attempt: number;
  /** An earlier attempt that may have been delivered was a private reply. */
  uncertainPrivateReply: boolean;
}

/**
 * Records a new attempt as pending, or null if the lease was lost. A previous
 * attempt still pending died mid-call, so it may have been delivered.
 */
export async function markPending(
  q: Queryable,
  lease: Lease,
  key: EffectKey,
  channel: Channel,
  now: Date,
): Promise<PendingAttempt | null> {
  const { rows } = await q.query<{ attempt: number; uncertain_private_reply: boolean }>(
    `INSERT INTO step_executions (run_id, step_index, effect_key, attempt, attempted_at, channel, status, created_at, updated_at)
     SELECT $1, $2, $3, 1, $5, $6, 'pending', $5, $5
     FROM runs WHERE id = $1 AND lease_until = $4
     ON CONFLICT (run_id, step_index, effect_key) DO UPDATE
       SET attempt = step_executions.attempt + 1, attempted_at = $5, channel = $6, status = 'pending', error = NULL,
           updated_at = $5,
           uncertain_since = CASE WHEN step_executions.status = 'pending'
             THEN coalesce(step_executions.uncertain_since, step_executions.attempted_at)
             ELSE step_executions.uncertain_since END,
           uncertain_private_reply = step_executions.uncertain_private_reply
             OR (step_executions.status = 'pending' AND step_executions.channel = 'private_reply')
     RETURNING attempt, uncertain_private_reply`,
    [...keyParams(key), lease.until, now, channel],
  );
  return rows[0] ? { attempt: rows[0].attempt, uncertainPrivateReply: rows[0].uncertain_private_reply } : null;
}

export async function markSent(
  q: Queryable,
  key: EffectKey,
  attempt: number,
  messageId: string | null,
  now: Date,
): Promise<SentEffect> {
  const { rows } = await q.query<{ private_reply_used: boolean }>(
    `UPDATE step_executions SET status = 'sent', external_message_id = $5, updated_at = $6
     WHERE run_id = $1 AND step_index = $2 AND effect_key = $3 AND attempt = $4
     RETURNING ${PRIVATE_REPLY_USED} AS private_reply_used`,
    [...keyParams(key), attempt, messageId, now],
  );
  return { messageId, privateReplyUsed: rows[0]?.private_reply_used ?? false };
}

/** uncertain: the attempt may have been delivered anyway, as when the call timed out. */
export async function markFailed(
  q: Queryable,
  key: EffectKey,
  attempt: number,
  error: string,
  uncertain: boolean,
  now: Date,
) {
  await q.query(
    `UPDATE step_executions SET status = 'failed', error = $5, updated_at = $6,
       uncertain_since = CASE WHEN $7 THEN coalesce(uncertain_since, attempted_at) ELSE uncertain_since END,
       uncertain_private_reply = uncertain_private_reply OR ($7 AND channel = 'private_reply')
     WHERE run_id = $1 AND step_index = $2 AND effect_key = $3 AND attempt = $4`,
    [...keyParams(key), attempt, error, now, uncertain],
  );
}

/**
 * When the run's most recent side effect may first have reached the contact:
 * the earliest attempt that may have been delivered, else the one that was.
 */
export async function latestSentAt(q: Queryable, runId: string): Promise<Date | null> {
  const { rows } = await q.query<{ at: Date | null }>(
    `SELECT max(coalesce(uncertain_since, attempted_at)) AS at FROM step_executions
     WHERE run_id = $1 AND status = 'sent'`,
    [runId],
  );
  return rows[0]?.at ?? null;
}
