import type { Clock } from '../clock.js';
import { canAnswer, resumeWithReply } from '../core/conversation.js';
import type { InboundDm, InboundEvent } from '../core/inbound.js';
import { planRunsForComment } from '../core/planner.js';
import type { ContactKey } from '../core/types.js';
import { withSavepoint, withTransaction, type Db, type Tx } from '../db/pool.js';
import * as automations from '../store/automations.js';
import * as events from '../store/events.js';
import { tryLockContact } from '../store/locks.js';
import * as runs from '../store/runs.js';

/**
 * Turns stored inbound events into run changes. All events for one contact are
 * handled under that contact's advisory lock, oldest first, so two dispatchers
 * never handle the same contact at once or out of order.
 */
export interface DispatcherOptions {
  batchSize?: number;
  /** An event is dead-lettered after this many failed dispatches. */
  maxFailures?: number;
  /** Called when an event fails. It is retried on a later tick until dead-lettered. */
  onError?: (err: unknown, contact: ContactKey) => void;
}

export class EventDispatcher {
  private readonly batchSize: number;
  private readonly maxFailures: number;
  private readonly onError: (err: unknown, contact: ContactKey) => void;

  constructor(
    private readonly deps: { db: Db; clock: Clock },
    opts: DispatcherOptions = {},
  ) {
    this.batchSize = opts.batchSize ?? 20;
    this.maxFailures = opts.maxFailures ?? 5;
    this.onError = opts.onError ?? ((err, contact) => console.error('dispatch failed for', contact, err));
  }

  /** Returns the number of events processed. */
  async tick(): Promise<number> {
    const contacts = await events.contactsWithPendingEvents(this.deps.db, this.batchSize);
    let processed = 0;
    for (const contact of contacts) {
      try {
        processed += await withTransaction(this.deps.db, async (tx) =>
          (await tryLockContact(tx, contact)) ? this.dispatchContact(tx, contact) : 0,
        );
      } catch (err) {
        this.onError(err, contact);
      }
    }
    return processed;
  }

  /**
   * A failing event stops the contact's batch, so later events never overtake it.
   * Once dead-lettered it no longer blocks them.
   */
  private async dispatchContact(tx: Tx, contact: ContactKey): Promise<number> {
    const pending = await events.pendingEventsForContact(tx, contact);
    let processed = 0;
    for (const event of pending) {
      try {
        await withSavepoint(tx, async () => {
          if (event.kind === 'comment') await this.onComment(tx, event);
          else await this.onDm(tx, event);
          await events.markProcessed(tx, event.id, this.deps.clock.now());
        });
      } catch (err) {
        this.onError(err, contact);
        const message = err instanceof Error ? err.message : String(err);
        const dead = await events.recordDispatchFailure(tx, event.id, message, this.maxFailures, this.deps.clock.now());
        if (!dead) break;
      }
      processed++;
    }
    return processed;
  }

  /**
   * Resumes the contact's waiting run with this DM. A DM nobody is waiting for
   * stays unconsumed: a run that reaches its wait step later checks for it.
   */
  private async onDm(tx: Tx, dm: InboundDm): Promise<void> {
    if (dm.consumedByRunId) return;
    const run = await runs.findWaiting(tx, dm.contact);
    if (!run || !canAnswer(run, dm.receivedAt)) return;
    const now = this.deps.clock.now();
    const update = resumeWithReply(run, run.context.wait, { eventId: dm.id, text: dm.payload.text }, now);
    if (await runs.resumeIfWaiting(tx, run.id, update, now)) await events.markConsumed(tx, dm.id, run.id);
  }

  private async onComment(tx: Tx, event: Extract<InboundEvent, { kind: 'comment' }>): Promise<void> {
    // The account's own comments, such as a reply that repeats the keyword, never trigger it.
    if (event.contact.contactId === event.contact.accountId) return;
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
