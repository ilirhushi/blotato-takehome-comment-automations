import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startEngine } from '../src/app/runner.js';
import type { Db } from '../src/db/pool.js';
import { createTestDb, type TestDb } from './helpers.js';
import { createHarness, type Harness } from './harness.js';

const pricing = { type: 'comment_keyword', keyword: 'pricing', post_ids: null };
const replyAndDm = [
  { type: 'reply_to_comment', text: 'Sent you a DM!' },
  { type: 'send_dm', text: 'Hi {{username}}! Here is our pricing.' },
];
const fast = { pollMs: 5, schedulerPollMs: 5 };

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

describe('startEngine', () => {
  it('runs a comment through to completion', async () => {
    await h.createAutomation(pricing, replyAndDm);
    const engine = startEngine({ db: h.db, clock: h.clock, client: h.client }, fast);
    try {
      await h.comment('alice', 'pricing');
      await expect.poll(async () => (await h.runs())[0]?.status).toBe('completed');
      expect(h.client.sent.map((m) => m.kind)).toEqual(['comment_reply', 'dm']);
    } finally {
      await engine.stop();
    }
  });

  it('lets an in-flight step finish when stopped', async () => {
    await h.createAutomation(pricing, replyAndDm);
    const release = h.client.holdNext();
    const engine = startEngine({ db: h.db, clock: h.clock, client: h.client }, { ...fast, workers: 1 });
    await h.comment('alice', 'pricing');
    await expect.poll(() => h.client.sent.length).toBe(1);

    let stopped = false;
    const stopping = engine.stop().then(() => (stopped = true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(false);
    release();
    await stopping;

    const [run] = await h.runs();
    expect(run).toMatchObject({ status: 'running', current_step: 1, lease_until: null });
    expect(await h.stepExecutions()).toMatchObject([{ step_index: 0, status: 'sent' }]);
    expect(h.client.sent).toHaveLength(1);
  });

  it('keeps a loop running after a tick throws', async () => {
    await h.createAutomation(pricing, replyAndDm);
    let failures = 0;
    const flaky = new Proxy(h.db, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop !== 'query') return typeof value === 'function' ? value.bind(target) : value;
        return (...args: unknown[]) => {
          if (failures < 3 && String(args[0]).includes('GROUP BY account_id')) {
            failures++;
            return Promise.reject(new Error('Connection terminated unexpectedly'));
          }
          return (target.query as (...a: unknown[]) => unknown)(...args);
        };
      },
    }) as Db;
    const errors: unknown[] = [];
    const engine = startEngine(
      { db: flaky, clock: h.clock, client: h.client },
      { ...fast, onError: (err) => errors.push(err) },
    );
    try {
      await h.comment('alice', 'pricing');
      await expect.poll(async () => (await h.runs())[0]?.status).toBe('completed');
      expect(errors).toHaveLength(3);
    } finally {
      await engine.stop();
    }
  });

  it('stops promptly when stopped during an idle tick', async () => {
    const slow = new Proxy(h.db, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop !== 'query') return typeof value === 'function' ? value.bind(target) : value;
        return async (...args: unknown[]) => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return (target.query as (...a: unknown[]) => unknown)(...args);
        };
      },
    }) as Db;
    const engine = startEngine({ db: slow, clock: h.clock, client: h.client }, { pollMs: 5_000, schedulerPollMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const started = Date.now();
    await engine.stop();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
