import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventDispatcher } from '../src/app/event-dispatcher.js';
import { Worker } from '../src/app/worker.js';
import type { ContactKey } from '../src/core/types.js';
import { withTransaction, type Db } from '../src/db/pool.js';
import { PermanentPlatformError, TransientPlatformError } from '../src/platform/types.js';
import { lockContact } from '../src/store/locks.js';
import { createTestDb, type TestDb } from './helpers.js';
import { ACCOUNT, createHarness, type Harness } from './harness.js';

const pricing = { type: 'comment_keyword', keyword: 'pricing', post_ids: null };
const replyAndDm = [
  { type: 'reply_to_comment', text: 'Sent you a DM!' },
  { type: 'send_dm', text: 'Hi {{username}}! Here is our pricing.' },
];

let t: TestDb;
let h: Harness;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.truncate();
  h = createHarness(t);
});

describe('dispatching comments', () => {
  it('replies to the comment and sends the first DM as a private reply', async () => {
    await h.createAutomation(pricing, replyAndDm);
    await h.comment('alice', 'Pricing please', { commentId: 'c-alice' });
    await h.drain();

    expect(h.client.sent).toMatchObject([
      { kind: 'comment_reply', commentId: 'c-alice', text: 'Sent you a DM!' },
      { kind: 'dm', contactId: 'alice', text: 'Hi user_alice! Here is our pricing.', replyToCommentId: 'c-alice' },
    ]);
    const [run] = await h.runs();
    expect(run).toMatchObject({ status: 'completed', current_step: 2, lease_until: null });
    expect(run.context.private_reply_used).toBe(true);
    expect(await h.stepExecutions()).toEqual([
      { step_index: 0, effect_key: 'main', attempt: 1, status: 'sent', error: null },
      { step_index: 1, effect_key: 'main', attempt: 1, status: 'sent', error: null },
    ]);
    const { rows } = await h.db.query(`SELECT processed_at FROM inbound_events`);
    expect(rows[0].processed_at).not.toBeNull();
  });

  it('handles a duplicate comment webhook once', async () => {
    await h.createAutomation(pricing, replyAndDm);
    expect(await h.comment('alice', 'pricing', { commentId: 'c-dup' })).not.toBeNull();
    expect(await h.comment('alice', 'pricing', { commentId: 'c-dup' })).toBeNull();
    await h.drain();
    expect(await h.runs()).toHaveLength(1);
    expect(h.client.sent).toHaveLength(2);
  });

  it('starts one run when the same user comments twice before dispatch', async () => {
    await h.createAutomation(pricing, replyAndDm);
    await h.comment('alice', 'pricing');
    await h.comment('alice', 'pricing please');
    await h.drain();
    expect((await h.runs()).map((r) => r.status)).toEqual(['completed', 'skipped']);
    expect(h.client.sent.map((m) => m.kind)).toEqual(['comment_reply', 'dm']);
  });

  it('starts a new run when the user comments again after the previous one finished', async () => {
    await h.createAutomation(pricing, replyAndDm);
    await h.comment('alice', 'pricing');
    await h.drain();
    await h.comment('alice', 'pricing again');
    await h.drain();
    expect((await h.runs()).map((r) => r.status)).toEqual(['completed', 'completed']);
  });

  it('ignores comments that do not match', async () => {
    await h.createAutomation(pricing, replyAndDm);
    await h.comment('alice', 'repricing is wild');
    await h.drain();
    expect(await h.runs()).toEqual([]);
    expect(h.client.sent).toEqual([]);
  });

  it("ignores the account's own comments", async () => {
    await h.createAutomation(pricing, replyAndDm);
    await h.comment(ACCOUNT, 'Pricing sent to your DMs!');
    await h.drain();
    expect(await h.runs()).toEqual([]);
    expect(h.client.sent).toEqual([]);
  });

  it('runs only the first matching automation and skips the rest', async () => {
    const first = await h.createAutomation(pricing, replyAndDm);
    const second = await h.createAutomation(pricing, [{ type: 'reply_to_comment', text: 'second' }]);
    await h.comment('alice', 'pricing');
    await h.drain();

    const runs = await h.runs();
    expect(runs.map((r) => [r.automation_id, r.status])).toEqual([
      [first.automationId, 'completed'],
      [second.automationId, 'skipped'],
    ]);
    expect(runs[1].context.outcome).toBe('another_automation_matched');
    expect(h.client.sent.map((m) => m.text)).not.toContain('second');
  });

  it('skips a new trigger while the contact has an active run', async () => {
    await h.createAutomation(pricing, replyAndDm);
    h.client.failNext(new TransientPlatformError('503'));
    await h.comment('alice', 'pricing');
    await h.drain();
    expect((await h.runs())[0].status).toBe('running');

    await h.comment('alice', 'pricing again');
    await h.drain();
    expect((await h.runs()).map((r) => r.status)).toEqual(['running', 'skipped']);
  });

  it('marks a DM with no active conversation as processed without creating a run', async () => {
    await h.createAutomation(pricing, replyAndDm);
    await h.dm('alice', 'hello');
    await h.drain();
    expect(await h.runs()).toEqual([]);
    const { rows } = await h.db.query(`SELECT processed_at, consumed_by_run_id FROM inbound_events`);
    expect(rows[0].processed_at).not.toBeNull();
    expect(rows[0].consumed_by_run_id).toBeNull();
  });
});

/** Makes every run insert for contact 'poison' fail, as a stand-in for an event that always breaks dispatch. */
const createPoison = () =>
  h.db.query(`
    CREATE FUNCTION reject_poison() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'poisoned'; END $$;
    CREATE TRIGGER reject_poison BEFORE INSERT ON runs
      FOR EACH ROW WHEN (NEW.contact_id = 'poison') EXECUTE FUNCTION reject_poison();`);
const dropPoison = () => h.db.query(`DROP TRIGGER reject_poison ON runs; DROP FUNCTION reject_poison();`);

/** A pool whose query fails with a dropped connection whenever the SQL matches. */
function flakyDb(db: Db, matches: (sql: string) => boolean, times = Infinity) {
  const state = { failures: 0 };
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== 'query') return Reflect.get(target, prop, receiver);
      return (...args: unknown[]) => {
        if (state.failures < times && matches(String(args[0]))) {
          state.failures++;
          return Promise.reject(new Error('Connection terminated unexpectedly'));
        }
        return (target.query as (...a: unknown[]) => unknown)(...args);
      };
    },
  }) as Db;
  return { db: proxy, state };
}

describe('dispatcher isolation', () => {
  it('leaves a contact alone while another transaction holds its lock', async () => {
    await h.createAutomation(pricing, replyAndDm);
    await h.comment('alice', 'pricing');
    const contact: ContactKey = { accountId: ACCOUNT, platform: 'instagram', contactId: 'alice' };

    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = withTransaction(h.db, async (tx) => {
      await lockContact(tx, contact);
      locked();
      await released;
    });
    await isLocked;
    expect(await h.dispatcher.tick()).toBe(0);
    release();
    await holder;
    expect(await h.dispatcher.tick()).toBe(1);
  });

  it('keeps dispatching other contacts when one contact fails', async () => {
    await h.createAutomation(pricing, replyAndDm);
    await createPoison();
    try {
      await h.comment('poison', 'pricing');
      await h.comment('alice', 'pricing');
      const errors: string[] = [];
      const dispatcher = new EventDispatcher(
        { db: h.db, clock: h.clock },
        { onError: (err, contact) => errors.push(`${contact.contactId}: ${(err as Error).message}`) },
      );

      expect(await dispatcher.tick()).toBe(1);
      expect(errors).toEqual(['poison: poisoned']);
      expect((await h.runs()).map((r) => r.contact_id)).toEqual(['alice']);
      const { rows } = await h.db.query(
        `SELECT processed_at, dispatch_failures, last_dispatch_error FROM inbound_events WHERE contact_id = 'poison'`,
      );
      expect(rows).toEqual([{ processed_at: null, dispatch_failures: 1, last_dispatch_error: 'poisoned' }]);
    } finally {
      await dropPoison();
    }
  });

  it('dead-letters an event after 5 failed dispatches, so the contact and the batch move on', async () => {
    await h.createAutomation(pricing, replyAndDm);
    await createPoison();
    try {
      await h.comment('poison', 'pricing');
      await h.comment('poison', 'pricing again');
      await h.comment('alice', 'pricing');
      const dispatcher = new EventDispatcher({ db: h.db, clock: h.clock }, { batchSize: 1, onError: () => {} });

      for (let i = 0; i < 4; i++) expect(await dispatcher.tick()).toBe(0);
      expect(await dispatcher.tick()).toBe(1); // dead-letters the first poison comment; the second fails once
      for (let i = 0; i < 3; i++) expect(await dispatcher.tick()).toBe(0);
      expect(await dispatcher.tick()).toBe(1); // dead-letters the second
      expect(await dispatcher.tick()).toBe(1); // alice
      expect((await h.runs()).map((r) => r.contact_id)).toEqual(['alice']);

      const { rows } = await h.db.query(
        `SELECT contact_id, dispatch_failures, dead_lettered_at IS NOT NULL AS dead, processed_at IS NOT NULL AS processed
         FROM inbound_events ORDER BY id`,
      );
      expect(rows).toEqual([
        { contact_id: 'poison', dispatch_failures: 5, dead: true, processed: true },
        { contact_id: 'poison', dispatch_failures: 5, dead: true, processed: true },
        { contact_id: 'alice', dispatch_failures: 0, dead: false, processed: true },
      ]);
    } finally {
      await dropPoison();
    }
  });
});

describe('failures and retries', () => {
  it('retries a transient failure after backoff', async () => {
    await h.createAutomation(pricing, replyAndDm);
    h.client.failNext(new TransientPlatformError('503'));
    await h.comment('alice', 'pricing');
    await h.drain();

    const [run] = await h.runs();
    expect(run.status).toBe('running');
    expect(run.wake_at.getTime() - h.clock.now().getTime()).toBe(2_000);
    expect(await h.worker.tick()).toBe(false);

    h.clock.advance(2_000);
    await h.drain();
    expect((await h.runs())[0].status).toBe('completed');
    expect((await h.stepExecutions())[0]).toMatchObject({ step_index: 0, attempt: 2, status: 'sent' });
    expect(h.client.sent).toHaveLength(2);
  });

  it('fails the run once retries are exhausted', async () => {
    h = createHarness(t, { retryPolicy: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 60_000 } });
    await h.createAutomation(pricing, replyAndDm);
    h.client.failNext(...Array.from({ length: 3 }, () => new TransientPlatformError('503')));
    await h.comment('alice', 'pricing');
    for (let i = 0; i < 3; i++) {
      await h.drain();
      h.clock.advance(60_000);
    }
    const [run] = await h.runs();
    expect(run).toMatchObject({ status: 'failed', error: 'gave up after 3 attempts: 503' });
    expect(h.client.sent).toEqual([]);
  });

  it('fails the run immediately on a permanent error', async () => {
    await h.createAutomation(pricing, replyAndDm);
    h.client.failNext(new PermanentPlatformError('comment deleted'));
    await h.comment('alice', 'pricing');
    await h.drain();
    expect((await h.runs())[0]).toMatchObject({ status: 'failed', error: 'comment deleted' });
    expect(await h.stepExecutions()).toMatchObject([{ status: 'failed', error: 'comment deleted' }]);
  });

  it('fails the run when the platform does not allow the DM', async () => {
    await h.createAutomation(pricing, replyAndDm);
    await h.comment('alice', 'pricing');
    await h.dispatcher.tick();
    await h.worker.tick();
    h.clock.advance(8 * 24 * 60 * 60 * 1000);
    await h.drain();
    expect((await h.runs())[0]).toMatchObject({ status: 'failed', error: 'comment is too old for a private reply' });
    expect(h.client.sent.map((m) => m.kind)).toEqual(['comment_reply']);
  });

  it('retries a step after a dropped database connection', async () => {
    await h.createAutomation(pricing, [{ type: 'send_dm', text: 'Hi!' }]);
    await h.comment('alice', 'pricing');
    await h.dispatcher.tick();

    const flaky = flakyDb(h.db, (sql) => sql.includes('max(received_at)'), 1);
    await new Worker({ db: flaky.db, clock: h.clock, client: h.client }, { random: () => 1 }).tick();
    expect(flaky.state.failures).toBe(1);
    expect((await h.runs())[0]).toMatchObject({ status: 'running', error: null });

    h.clock.advance(2_000);
    await h.drain();
    expect((await h.runs())[0].status).toBe('completed');
    expect(h.dmTexts()).toEqual(['Hi!']);
  });

  it('retries a step whose run update hit a dropped connection after the send, without sending again', async () => {
    await h.createAutomation(pricing, replyAndDm);
    await h.comment('alice', 'pricing');
    await h.dispatcher.tick();

    const flaky = flakyDb(h.db, (sql) => sql.includes('SET current_step'), 1);
    await new Worker({ db: flaky.db, clock: h.clock, client: h.client }, { random: () => 1 }).tick();
    expect(flaky.state.failures).toBe(1);
    expect((await h.runs())[0]).toMatchObject({ status: 'running', current_step: 0, failures: 1, error: null });

    h.clock.advance(2_000);
    await h.drain();
    expect((await h.runs())[0].status).toBe('completed');
    expect(h.client.sent.map((m) => m.kind)).toEqual(['comment_reply', 'dm']);
  });

  it('gives up on a database error that keeps failing before any send', async () => {
    const retryPolicy = { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 1_000 };
    await h.createAutomation(pricing, [{ type: 'send_dm', text: 'Hi!' }]);
    await h.comment('alice', 'pricing');
    await h.dispatcher.tick();

    const flaky = flakyDb(h.db, (sql) => sql.includes('max(received_at)'));
    const worker = new Worker({ db: flaky.db, clock: h.clock, client: h.client }, { retryPolicy, random: () => 1 });
    for (let i = 0; i < 5; i++) {
      await worker.tick();
      h.clock.advance(1_000);
    }
    expect(flaky.state.failures).toBe(3);
    expect((await h.runs())[0]).toMatchObject({
      status: 'failed',
      error: 'gave up after 3 attempts: Connection terminated unexpectedly',
    });
    expect(h.client.sent).toEqual([]);
  });

  it('times out a platform call that hangs, and retries it within the lease', async () => {
    await h.createAutomation(pricing, [{ type: 'reply_to_comment', text: 'Sent you a DM!' }]);
    await h.comment('alice', 'pricing');
    await h.dispatcher.tick();

    const release = h.client.holdNext();
    await h.newWorker({ sendTimeoutMs: 20 }).tick();
    expect((await h.runs())[0]).toMatchObject({ status: 'running', lease_until: null });
    expect(await h.stepExecutions()).toMatchObject([{ attempt: 1, status: 'failed', error: 'platform call timed out after 20 ms' }]);
    release();

    h.clock.advance(2_000);
    await h.drain();
    expect((await h.runs())[0].status).toBe('completed');
    expect(await h.stepExecutions()).toMatchObject([{ attempt: 2, status: 'sent' }]);
  });

  it('fails a run whose worker keeps dying after the send, once attempts are used up', async () => {
    h = createHarness(t, { retryPolicy: { maxAttempts: 2, baseDelayMs: 1_000, maxDelayMs: 1_000 } });
    await h.createAutomation(pricing, [{ type: 'reply_to_comment', text: 'Sent you a DM!' }]);
    await h.comment('alice', 'pricing');
    await h.dispatcher.tick();

    const releases = [h.client.holdNext(), h.client.holdNext()];
    const dying = [];
    for (let i = 1; i <= 2; i++) {
      dying.push(h.newWorker().tick());
      await expect.poll(() => h.client.sent.length).toBe(i);
      h.clock.advance(30_001);
    }
    await h.worker.tick();
    releases.forEach((release) => release());
    await Promise.all(dying);

    expect(h.client.sent).toHaveLength(2);
    expect((await h.runs())[0]).toMatchObject({ status: 'failed', error: 'gave up after 2 attempts' });
    expect(await h.worker.tick()).toBe(false);
  });
});

describe('leases', () => {
  it('re-sends after a worker dies mid-send, and the stale worker cannot move the run back', async () => {
    await h.createAutomation(pricing, replyAndDm);
    await h.comment('alice', 'pricing');
    await h.dispatcher.tick();

    const release = h.client.holdNext();
    const stale = h.newWorker({ leaseMs: 30_000 });
    const staleTick = stale.tick();
    await expect.poll(() => h.client.sent.length).toBe(1);

    h.clock.advance(30_001);
    expect(await h.worker.tick()).toBe(true); // re-sends the comment reply
    expect(await h.worker.tick()).toBe(true); // sends the DM and completes the run
    release();
    await staleTick;

    // At-least-once: the reply went out twice, but the stale worker's write was fenced off.
    expect((await h.runs())[0]).toMatchObject({ status: 'completed', current_step: 2, lease_until: null });
    expect(h.client.sent.map((m) => m.kind)).toEqual(['comment_reply', 'comment_reply', 'dm']);
    expect(await h.stepExecutions()).toMatchObject([
      { step_index: 0, attempt: 2, status: 'sent' },
      { step_index: 1, attempt: 1, status: 'sent' },
    ]);
  });

  it('treats a rejected duplicate private reply as delivered when an earlier attempt may have sent it', async () => {
    await h.createAutomation(pricing, replyAndDm);
    await h.comment('alice', 'pricing');
    await h.dispatcher.tick();
    await h.worker.tick(); // reply to comment

    const release = h.client.holdNext();
    const staleTick = h.newWorker().tick(); // the private reply is delivered, then the worker stalls
    await expect.poll(() => h.client.sent.length).toBe(2);
    h.clock.advance(30_001);
    await h.worker.tick();
    release();
    await staleTick;

    const [run] = await h.runs();
    expect(run).toMatchObject({ status: 'completed', error: null });
    expect(run.context.private_reply_used).toBe(true);
    expect(h.client.sent.map((m) => m.kind)).toEqual(['comment_reply', 'dm']);
    expect((await h.stepExecutions())[1]).toMatchObject({ attempt: 2, status: 'sent' });
  });

  it('remembers a private reply was used when a sent DM is replayed after the window opened', async () => {
    await h.createAutomation(pricing, replyAndDm);
    await h.comment('alice', 'pricing');
    await h.dispatcher.tick();
    await h.worker.tick(); // reply to comment

    const flaky = flakyDb(h.db, (sql) => sql.includes('SET current_step'), 1);
    await new Worker({ db: flaky.db, clock: h.clock, client: h.client }, { random: () => 1 }).tick();
    expect(flaky.state.failures).toBe(1);
    await h.dm('alice', 'thanks!'); // opens the 24h window, so a fresh decision would be a standard DM
    h.clock.advance(2_000);
    await h.drain();

    const [run] = await h.runs();
    expect(run.status).toBe('completed');
    expect(run.context.private_reply_used).toBe(true);
    expect(h.client.sent.map((m) => m.kind)).toEqual(['comment_reply', 'dm']);
  });

  it('never runs a step twice when several workers claim in parallel', async () => {
    await h.createAutomation(pricing, replyAndDm);
    const contacts = Array.from({ length: 20 }, (_, i) => `c${i}`);
    for (const c of contacts) await h.comment(c, 'pricing');
    await h.dispatcher.tick();

    const loop = async (worker: Worker) => {
      while (await worker.tick());
    };
    await Promise.all(Array.from({ length: 4 }, () => loop(h.newWorker())));
    await h.drain();

    expect(h.client.sent).toHaveLength(40);
    expect((await h.runs()).map((r) => r.status)).toEqual(contacts.map(() => 'completed'));
    expect((await h.stepExecutions()).every((e) => e.attempt === 1 && e.status === 'sent')).toBe(true);
  });
});
