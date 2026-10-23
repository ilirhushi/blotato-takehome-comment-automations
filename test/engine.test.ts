import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PermanentPlatformError, TransientPlatformError } from '../src/platform/types.js';
import { createTestDb, type TestDb } from './helpers.js';
import { createHarness, type Harness } from './harness.js';

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
    expect(runs[1].context.outcome).toBe('contact_busy');
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

describe('failures and retries', () => {
  it('retries a transient failure after backoff', async () => {
    await h.createAutomation(pricing, replyAndDm);
    h.client.failNext(new TransientPlatformError('503'));
    await h.comment('alice', 'pricing');
    await h.drain();

    const [run] = await h.runs();
    expect(run.status).toBe('running');
    expect(run.wake_at.getTime() - h.clock.now().getTime()).toBe(1_000);
    expect(await h.worker.tick()).toBe(false);

    h.clock.advance(1_000);
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
});

describe('leases', () => {
  it('re-sends after a worker dies mid-send, and the stale worker cannot advance the run', async () => {
    await h.createAutomation(pricing, [{ type: 'reply_to_comment', text: 'Sent you a DM!' }]);
    await h.comment('alice', 'pricing');
    await h.dispatcher.tick();

    const release = h.client.holdNext();
    const stale = h.newWorker({ leaseMs: 30_000 });
    const staleTick = stale.tick();
    await expect.poll(() => h.client.sent.length).toBe(1);

    h.clock.advance(30_001);
    expect(await h.worker.tick()).toBe(true);
    release();
    await staleTick;

    // At-least-once: the reply went out twice, but the run advanced exactly once.
    expect(h.client.sent).toHaveLength(2);
    expect((await h.runs())[0]).toMatchObject({ status: 'completed', current_step: 1, lease_until: null });
    expect(await h.stepExecutions()).toMatchObject([{ attempt: 2, status: 'sent' }]);
  });
});
