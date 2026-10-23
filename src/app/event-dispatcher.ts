import type { Clock } from '../clock.js';
import type { InboundEvent } from '../core/inbound.js';
import { planRunsForComment } from '../core/planner.js';
import type { ContactKey } from '../core/types.js';
import { withTransaction, type Db, type Tx } from '../db/pool.js';
import * as automations from '../store/automations.js';
import * as events from '../store/events.js';
import { tryLockContact } from '../store/locks.js';
import * as runs from '../store/runs.js';

/**
 * Turns stored inbound events into run changes. All events for one contact are
 * handled under that contact's advisory lock, oldest first, so two dispatchers
 * never handle the same contact at once or out of order.
 */
export class EventDispatcher {
  constructor(
    private readonly deps: { db: Db; clock: Clock },
    private readonly batchSize = 20,
  ) {}

  /** Returns the number of events processed. */
  async tick(): Promise<number> {
    const contacts = await events.contactsWithPendingEvents(this.deps.db, this.batchSize);
    let processed = 0;
    for (const contact of contacts) {
      processed += await withTransaction(this.deps.db, async (tx) =>
        (await tryLockContact(tx, contact)) ? this.dispatchContact(tx, contact) : 0,
      );
    }
    return processed;
  }

  private async dispatchContact(tx: Tx, contact: ContactKey): Promise<number> {
    const pending = await events.pendingEventsForContact(tx, contact);
    for (const event of pending) {
      if (event.kind === 'comment') await this.onComment(tx, event);
      // A DM nobody is waiting for stays available: a run that reaches its wait
      // step later checks for replies that arrived early.
      await events.markProcessed(tx, event.id, this.deps.clock.now());
    }
    return pending.length;
  }

  private async onComment(tx: Tx, event: Extract<InboundEvent, { kind: 'comment' }>): Promise<void> {
    const candidates = await automations.enabledForAccount(tx, event.contact);
    const busy = await runs.hasActiveRun(tx, event.contact);
    const now = this.deps.clock.now();
    for (const planned of planRunsForComment(candidates, event.payload, busy)) {
      await runs.insertRun(
        tx,
        {
          ...planned,
          contact: event.contact,
          triggerEventId: event.id,
          wakeAt: planned.status === 'running' ? now : null,
        },
        now,
      );
    }
  }
}
