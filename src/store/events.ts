import type { InboundDm, InboundEvent, NewInboundEvent } from '../core/inbound.js';
import type { ContactKey, Platform } from '../core/types.js';
import type { Queryable } from '../db/pool.js';

interface EventRow {
  id: string;
  account_id: string;
  platform: Platform;
  contact_id: string;
  kind: 'comment' | 'dm';
  payload: never;
  received_at: Date;
  consumed_by_run_id: string | null;
}

const COLUMNS = 'id, account_id, platform, contact_id, kind, payload, received_at, consumed_by_run_id';

const toEvent = (r: EventRow): InboundEvent => ({
  id: r.id,
  contact: { accountId: r.account_id, platform: r.platform, contactId: r.contact_id },
  kind: r.kind,
  payload: r.payload,
  receivedAt: r.received_at,
  consumedByRunId: r.consumed_by_run_id,
});

/** Returns the new event id, or null if the event was already stored. */
export async function insertEvent(q: Queryable, event: NewInboundEvent, receivedAt: Date): Promise<string | null> {
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO inbound_events (platform, platform_event_id, account_id, contact_id, kind, payload, received_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (platform, platform_event_id) DO NOTHING
     RETURNING id`,
    [
      event.contact.platform,
      event.platformEventId,
      event.contact.accountId,
      event.contact.contactId,
      event.kind,
      JSON.stringify(event.payload),
      receivedAt,
    ],
  );
  return rows[0]?.id ?? null;
}

export async function contactsWithPendingEvents(q: Queryable, limit: number): Promise<ContactKey[]> {
  const { rows } = await q.query<{ account_id: string; platform: Platform; contact_id: string }>(
    `SELECT account_id, platform, contact_id FROM inbound_events
     WHERE processed_at IS NULL
     GROUP BY account_id, platform, contact_id
     ORDER BY min(id)
     LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ accountId: r.account_id, platform: r.platform, contactId: r.contact_id }));
}

export async function pendingEventsForContact(q: Queryable, contact: ContactKey): Promise<InboundEvent[]> {
  const { rows } = await q.query<EventRow>(
    `SELECT ${COLUMNS} FROM inbound_events
     WHERE account_id = $1 AND platform = $2 AND contact_id = $3 AND processed_at IS NULL
     ORDER BY id`,
    [contact.accountId, contact.platform, contact.contactId],
  );
  return rows.map(toEvent);
}

export async function markProcessed(q: Queryable, eventId: string, at: Date): Promise<void> {
  await q.query(`UPDATE inbound_events SET processed_at = $2 WHERE id = $1`, [eventId, at]);
}

export async function lastDmAt(q: Queryable, contact: ContactKey): Promise<Date | null> {
  const { rows } = await q.query<{ at: Date | null }>(
    `SELECT max(received_at) AS at FROM inbound_events
     WHERE account_id = $1 AND platform = $2 AND contact_id = $3 AND kind = 'dm'`,
    [contact.accountId, contact.platform, contact.contactId],
  );
  return rows[0]?.at ?? null;
}

/** The oldest DM from the contact, received at or after since, that no run has consumed yet. */
export async function oldestUnconsumedDmSince(q: Queryable, contact: ContactKey, since: Date): Promise<InboundDm | null> {
  const { rows } = await q.query<EventRow>(
    `SELECT ${COLUMNS} FROM inbound_events
     WHERE account_id = $1 AND platform = $2 AND contact_id = $3
       AND kind = 'dm' AND consumed_by_run_id IS NULL AND received_at >= $4
     ORDER BY id
     LIMIT 1`,
    [contact.accountId, contact.platform, contact.contactId, since],
  );
  return rows[0] ? (toEvent(rows[0]) as InboundDm) : null;
}

export async function markConsumed(q: Queryable, eventId: string, runId: string): Promise<void> {
  await q.query(`UPDATE inbound_events SET consumed_by_run_id = $2 WHERE id = $1`, [eventId, runId]);
}
