import type { Clock } from '../clock.js';
import type { NewInboundEvent } from '../core/inbound.js';
import type { Db } from '../db/pool.js';
import { insertEvent } from '../store/events.js';

/** Stores an inbound event. Returns null for a duplicate delivery. */
export function ingestEvent(db: Db, clock: Clock, event: NewInboundEvent): Promise<string | null> {
  return insertEvent(db, event, clock.now());
}
