import { FakeClock } from '../src/clock.js';
import { createAutomation } from '../src/app/automations.js';
import { EventDispatcher } from '../src/app/event-dispatcher.js';
import { ingestEvent } from '../src/app/ingest.js';
import { Worker, type WorkerOptions } from '../src/app/worker.js';
import { MockPlatformClient } from '../src/platform/mock.js';
import type { TestDb } from './helpers.js';

export const ACCOUNT = 'acct-1';

export function createHarness(t: TestDb, workerOpts: WorkerOptions = {}) {
  const db = t.db;
  const clock = new FakeClock();
  const client = new MockPlatformClient();
  const deps = { db, clock, client };
  const dispatcher = new EventDispatcher(deps);
  const worker = new Worker(deps, { random: () => 1, ...workerOpts });
  let seq = 0;

  return {
    db,
    clock,
    client,
    dispatcher,
    worker,
    newWorker: (opts: WorkerOptions = {}) => new Worker(deps, { random: () => 1, ...workerOpts, ...opts }),

    createAutomation: (trigger: unknown, steps: unknown) =>
      createAutomation(db, { accountId: ACCOUNT, platform: 'instagram', trigger, steps }),

    comment(contactId: string, text: string, opts: { postId?: string; commentId?: string } = {}) {
      const commentId = opts.commentId ?? `c-${++seq}`;
      return ingestEvent(db, clock, {
        contact: { accountId: ACCOUNT, platform: 'instagram', contactId },
        platformEventId: commentId,
        kind: 'comment',
        payload: {
          comment_id: commentId,
          post_id: opts.postId ?? 'post-1',
          text,
          username: `user_${contactId}`,
          created_at: clock.now().toISOString(),
        },
      });
    },

    dm(contactId: string, text: string, opts: { messageId?: string } = {}) {
      const messageId = opts.messageId ?? `m-${++seq}`;
      return ingestEvent(db, clock, {
        contact: { accountId: ACCOUNT, platform: 'instagram', contactId },
        platformEventId: messageId,
        kind: 'dm',
        payload: { message_id: messageId, text },
      });
    },

    /** Runs dispatcher and worker until neither has anything left to do right now. */
    async drain(): Promise<void> {
      for (let i = 0; i < 200; i++) {
        const dispatched = await dispatcher.tick();
        const worked = await worker.tick();
        if (!dispatched && !worked) return;
      }
      throw new Error('drain did not settle');
    },

    async runs() {
      const { rows } = await db.query(
        `SELECT r.* FROM runs r JOIN automations a ON a.id = r.automation_id
         ORDER BY r.trigger_event_id, a.created_at`,
      );
      return rows;
    },

    async stepExecutions() {
      const { rows } = await db.query(
        `SELECT step_index, effect_key, attempt, status, error FROM step_executions ORDER BY id`,
      );
      return rows;
    },
  };
}

export type Harness = ReturnType<typeof createHarness>;
