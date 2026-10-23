import type { Lease, Run, RunContext, RunStatus, RunUpdate } from '../core/run.js';
import type { ContactKey, Platform } from '../core/types.js';
import type { Queryable } from '../db/pool.js';

interface RunRow {
  id: string;
  automation_id: string;
  automation_version_id: string;
  account_id: string;
  platform: Platform;
  contact_id: string;
  trigger_event_id: string;
  status: RunStatus;
  current_step: number;
  context: RunContext;
  wake_at: Date | null;
  waiting_since: Date | null;
  lease_until: Date | null;
  error: string | null;
}

const toRun = (r: RunRow): Run => ({
  id: r.id,
  automationId: r.automation_id,
  versionId: r.automation_version_id,
  contact: { accountId: r.account_id, platform: r.platform, contactId: r.contact_id },
  triggerEventId: r.trigger_event_id,
  status: r.status,
  currentStep: r.current_step,
  context: r.context,
  wakeAt: r.wake_at,
  waitingSince: r.waiting_since,
  leaseUntil: r.lease_until,
  error: r.error,
});

export async function hasActiveRun(q: Queryable, contact: ContactKey): Promise<boolean> {
  const { rowCount } = await q.query(
    `SELECT 1 FROM runs
     WHERE account_id = $1 AND platform = $2 AND contact_id = $3 AND status IN ('running', 'waiting')`,
    [contact.accountId, contact.platform, contact.contactId],
  );
  return (rowCount ?? 0) > 0;
}

export async function insertRun(
  q: Queryable,
  run: {
    automationId: string;
    versionId: string;
    contact: ContactKey;
    triggerEventId: string;
    status: 'running' | 'skipped';
    context: RunContext;
    wakeAt: Date | null;
  },
  now: Date,
): Promise<void> {
  await q.query(
    `INSERT INTO runs (automation_id, automation_version_id, account_id, platform, contact_id,
                       trigger_event_id, status, context, wake_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
     ON CONFLICT (automation_id, trigger_event_id) DO NOTHING`,
    [
      run.automationId,
      run.versionId,
      run.contact.accountId,
      run.contact.platform,
      run.contact.contactId,
      run.triggerEventId,
      run.status,
      JSON.stringify(run.context),
      run.wakeAt,
      now,
    ],
  );
}

/** Leases the next runnable run, skipping rows other workers are claiming right now. */
export async function claimRunnable(q: Queryable, now: Date, leaseUntil: Date): Promise<Run | null> {
  const { rows } = await q.query<RunRow>(
    `UPDATE runs SET lease_until = $2, updated_at = $1
     WHERE id = (
       SELECT id FROM runs
       WHERE status = 'running'
         AND (wake_at IS NULL OR wake_at <= $1)
         AND (lease_until IS NULL OR lease_until <= $1)
       ORDER BY wake_at NULLS FIRST
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [now, leaseUntil],
  );
  return rows[0] ? toRun(rows[0]) : null;
}

/**
 * The updates below apply only while the lease is still held, and release it.
 * Each returns false if another worker has taken the run over.
 */
async function updateIfLeaseHeld(q: Queryable, lease: Lease, set: string, params: unknown[], now: Date) {
  const { rowCount } = await q.query(
    `UPDATE runs SET ${set}, lease_until = NULL, updated_at = $${params.length + 3}
     WHERE id = $1 AND lease_until = $2`,
    [lease.runId, lease.until, ...params, now],
  );
  return (rowCount ?? 0) > 0;
}

export function applyIfLeaseHeld(q: Queryable, lease: Lease, update: RunUpdate, now: Date): Promise<boolean> {
  return updateIfLeaseHeld(
    q,
    lease,
    `current_step = $3, status = $4, context = $5, wake_at = $6, waiting_since = $7`,
    [update.currentStep, update.status, JSON.stringify(update.context), update.wakeAt, update.waitingSince],
    now,
  );
}

export function rescheduleIfLeaseHeld(q: Queryable, lease: Lease, wakeAt: Date, now: Date): Promise<boolean> {
  return updateIfLeaseHeld(q, lease, `wake_at = $3`, [wakeAt], now);
}

export function failIfLeaseHeld(q: Queryable, lease: Lease, reason: string, now: Date): Promise<boolean> {
  return updateIfLeaseHeld(q, lease, `status = 'failed', error = $3, wake_at = NULL`, [reason], now);
}

export async function findWaiting(q: Queryable, contact: ContactKey): Promise<Run | null> {
  const { rows } = await q.query<RunRow>(
    `SELECT * FROM runs
     WHERE account_id = $1 AND platform = $2 AND contact_id = $3 AND status = 'waiting'`,
    [contact.accountId, contact.platform, contact.contactId],
  );
  return rows[0] ? toRun(rows[0]) : null;
}

/** Applies the update only if the run is still waiting, so it cannot race with expiry. */
export async function resumeIfWaiting(q: Queryable, runId: string, update: RunUpdate, now: Date): Promise<boolean> {
  const { rowCount } = await q.query(
    `UPDATE runs SET status = $2, context = $3, wake_at = $4, waiting_since = $5, updated_at = $6
     WHERE id = $1 AND status = 'waiting'`,
    [runId, update.status, JSON.stringify(update.context), update.wakeAt, update.waitingSince, now],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Expires waiting runs past their deadline, except while the contact has a DM
 * received before the deadline that the dispatcher has not handled yet: it may
 * be the answer, and the dispatcher decides.
 */
export async function expireDue(q: Queryable, now: Date): Promise<number> {
  const { rowCount } = await q.query(
    `UPDATE runs r SET status = 'expired', wake_at = NULL, updated_at = $1
     WHERE r.status = 'waiting' AND r.wake_at <= $1
       AND NOT EXISTS (
         SELECT 1 FROM inbound_events e
         WHERE e.account_id = r.account_id AND e.platform = r.platform AND e.contact_id = r.contact_id
           AND e.kind = 'dm' AND e.processed_at IS NULL AND e.received_at < r.wake_at
       )`,
    [now],
  );
  return rowCount ?? 0;
}
