import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { publishVersion } from '../src/app/automations.js';
import { TransientPlatformError } from '../src/platform/types.js';
import { setEnabled } from '../src/store/automations.js';
import { createTestDb, type TestDb } from './helpers.js';
import { createHarness, type Harness } from './harness.js';

const MINUTE = 60_000;
const pricing = { type: 'comment_keyword', keyword: 'pricing', post_ids: null };
const steps = (maxReprompts = 2) => [
  { type: 'reply_to_comment', text: 'Sent you a DM!' },
  { type: 'send_dm', text: 'Hi {{username}}! What is your email?' },
  {
    type: 'wait_for_reply',
    validator: 'email',
    save_as: 'email',
    timeout_seconds: 3600,
    max_reprompts: maxReprompts,
    reprompt_text: 'Hmm, that does not look like an email. Try again?',
    give_up_text: 'No problem, {{username}}. Comment again any time!',
  },
  { type: 'send_dm', text: 'Thanks! Pricing is at https://example.com/pricing (we noted {{email}})' },
];
const LINK = 'Thanks! Pricing is at https://example.com/pricing (we noted ana@example.com)';
const REPROMPT = 'Hmm, that does not look like an email. Try again?';

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

/** Comment, then drain until the run is waiting for the email. */
async function startConversation(maxReprompts?: number) {
  const created = await h.createAutomation(pricing, steps(maxReprompts));
  await h.comment('ana', 'pricing');
  await h.drain();
  expect((await h.runs())[0].status).toBe('waiting');
  h.clock.advance(MINUTE);
  return created;
}

describe('wait_for_reply', () => {
  it('happy path: valid email gets the link', async () => {
    await startConversation();
    await h.dm('ana', 'ana@example.com');
    await h.drain();

    expect(h.dmTexts()).toEqual(['Hi user_ana! What is your email?', LINK]);
    const [run] = await h.runs();
    expect(run).toMatchObject({ status: 'completed', current_step: 4, wake_at: null, waiting_since: null });
    expect(run.context.vars.email).toBe('ana@example.com');
    expect(run.context.wait).toBeUndefined();
    const { rows } = await h.db.query(`SELECT consumed_by_run_id FROM inbound_events WHERE kind = 'dm'`);
    expect(rows).toEqual([{ consumed_by_run_id: run.id }]);
  });

  it('re-prompts on an invalid email, then accepts a valid one', async () => {
    await startConversation();
    await h.dm('ana', 'what?');
    await h.drain();
    expect(h.dmTexts().at(-1)).toBe(REPROMPT);
    const [waiting] = await h.runs();
    expect(waiting.status).toBe('waiting');
    expect(waiting.wake_at).toEqual(new Date(h.clock.now().getTime() + 3600_000));

    h.clock.advance(MINUTE);
    await h.dm('ana', 'ana@example.com');
    await h.drain();
    expect(h.dmTexts().slice(1)).toEqual([REPROMPT, LINK]);
    expect((await h.runs())[0].status).toBe('completed');
  });

  it('gives up politely after max_reprompts invalid replies', async () => {
    await startConversation(1);
    for (const text of ['nope', 'still nope']) {
      await h.dm('ana', text);
      await h.drain();
      h.clock.advance(MINUTE);
    }
    expect(h.dmTexts().slice(1)).toEqual([REPROMPT, 'No problem, user_ana. Comment again any time!']);
    const [run] = await h.runs();
    expect(run).toMatchObject({ status: 'completed', current_step: 2 });
    expect(run.context.outcome).toBe('gave_up');
    expect(await h.stepExecutions()).toMatchObject([
      { step_index: 0, effect_key: 'main' },
      { step_index: 1, effect_key: 'main' },
      { step_index: 2, effect_key: 'reprompt:1' },
      { step_index: 2, effect_key: 'give_up' },
    ]);
  });

  it('expires the run after the timeout and ignores later replies', async () => {
    await startConversation();
    h.clock.advance(59 * MINUTE - 1);
    expect(await h.scheduler.tick()).toBe(0);
    h.clock.advance(1);
    expect(await h.scheduler.tick()).toBe(1);

    await h.dm('ana', 'ana@example.com');
    await h.drain();
    expect((await h.runs())[0].status).toBe('expired');
    expect(h.dmTexts()).toHaveLength(1);
  });

  it('consumes a reply that arrives before the run starts waiting', async () => {
    await h.createAutomation(pricing, steps());
    await h.comment('ana', 'pricing');
    await h.dispatcher.tick();
    await h.worker.tick(); // reply to comment
    await h.worker.tick(); // prompt DM sent; run is now at the wait step but not waiting yet
    expect((await h.runs())[0]).toMatchObject({ status: 'running', current_step: 2 });

    await h.dm('ana', 'ana@example.com');
    await h.dispatcher.tick();
    await h.drain();
    expect(h.dmTexts()).toEqual(['Hi user_ana! What is your email?', LINK]);
    expect((await h.runs())[0].status).toBe('completed');
  });

  it('does not treat a DM sent before the prompt as the answer', async () => {
    await h.createAutomation(pricing, steps());
    await h.dm('ana', 'ana@example.com');
    h.clock.advance(MINUTE);
    await h.comment('ana', 'pricing');
    await h.drain();
    expect((await h.runs())[0].status).toBe('waiting');
  });

  it('handles an invalid and a valid reply sent back to back', async () => {
    await startConversation();
    await h.dm('ana', 'one sec');
    await h.dm('ana', 'ana@example.com');
    await h.drain();
    expect(h.dmTexts().slice(1)).toEqual([REPROMPT, LINK]);
    expect((await h.runs())[0].status).toBe('completed');
  });

  it('resumes once when two dispatchers handle concurrent DMs from the same contact', async () => {
    await startConversation();
    await h.dm('ana', 'ana@example.com');
    await h.dm('ana', 'ana+second@example.com');
    await Promise.all([h.newDispatcher().tick(), h.newDispatcher().tick(), h.newDispatcher().tick()]);
    await h.drain();

    expect(h.dmTexts()).toEqual(['Hi user_ana! What is your email?', LINK]);
    const { rows } = await h.db.query(
      `SELECT payload->>'text' AS text, consumed_by_run_id IS NOT NULL AS consumed, processed_at IS NOT NULL AS processed
       FROM inbound_events WHERE kind = 'dm' ORDER BY id`,
    );
    expect(rows).toEqual([
      { text: 'ana@example.com', consumed: true, processed: true },
      { text: 'ana+second@example.com', consumed: false, processed: true },
    ]);
  });

  it('does not expire a run whose reply arrived in time but is not dispatched yet', async () => {
    await startConversation();
    await h.dm('ana', 'ana@example.com');
    h.clock.advance(60 * MINUTE);
    expect(await h.scheduler.tick()).toBe(0);
    await h.drain();
    expect((await h.runs())[0].status).toBe('completed');
    expect(h.dmTexts().at(-1)).toBe(LINK);
  });

  it('still expires the run once an undispatched DM from before the prompt is dispatched', async () => {
    await h.createAutomation(pricing, steps());
    await h.comment('ana', 'pricing');
    await h.drain();
    // Simulate a DM sent before the prompt that the dispatcher has not reached yet.
    await h.db.query(
      `INSERT INTO inbound_events (platform, platform_event_id, account_id, contact_id, kind, payload, received_at)
       VALUES ('instagram', 'm-early', 'acct-1', 'ana', 'dm', '{"message_id":"m-early","text":"hi"}', $1)`,
      [new Date(h.clock.now().getTime() - MINUTE)],
    );
    h.clock.advance(60 * MINUTE);
    expect(await h.scheduler.tick()).toBe(0);
    await h.dispatcher.tick();
    expect(await h.scheduler.tick()).toBe(1);
  });

  it('ignores a reply sent after the deadline even if the scheduler has not run yet', async () => {
    await startConversation();
    h.clock.advance(60 * MINUTE);
    await h.dm('ana', 'ana@example.com');
    await h.drain();
    expect((await h.runs())[0].status).toBe('waiting');
    expect(await h.scheduler.tick()).toBe(1);
    expect(h.dmTexts()).toHaveLength(1);
  });

  it('sends one re-prompt when the first attempt fails transiently', async () => {
    await startConversation();
    h.client.failNext(new TransientPlatformError('503'));
    await h.dm('ana', 'what?');
    await h.drain();
    expect(h.dmTexts()).toHaveLength(1);

    h.clock.advance(MINUTE);
    await h.drain();
    expect(h.dmTexts().slice(1)).toEqual([REPROMPT]);
    expect((await h.runs())[0].status).toBe('waiting');
    expect(await h.stepExecutions()).toMatchObject([{}, {}, { effect_key: 'reprompt:1', attempt: 2, status: 'sent' }]);
  });

  it('handles a duplicate DM webhook once', async () => {
    await startConversation();
    expect(await h.dm('ana', 'ana@example.com', { messageId: 'm-dup' })).not.toBeNull();
    expect(await h.dm('ana', 'ana@example.com', { messageId: 'm-dup' })).toBeNull();
    await h.drain();
    expect(h.dmTexts()).toEqual(['Hi user_ana! What is your email?', LINK]);
  });

  it('finishes an in-flight run on its pinned version after the automation is edited', async () => {
    const { automationId, versionId } = await startConversation();
    const edited = steps();
    edited[3] = { type: 'send_dm', text: 'New link: https://example.com/v2' };
    const newVersionId = await publishVersion(h.db, automationId, pricing, edited);

    await h.dm('ana', 'ana@example.com');
    await h.comment('ben', 'pricing');
    await h.drain();
    await h.dm('ben', 'ben@example.com');
    await h.drain();

    const runs = await h.runs();
    expect(runs.map((r) => [r.contact_id, r.automation_version_id, r.status])).toEqual([
      ['ana', versionId, 'completed'],
      ['ben', newVersionId, 'completed'],
    ]);
    const lastDm = (contactId: string) =>
      h.client.sent.filter((m) => m.kind === 'dm' && m.contactId === contactId).at(-1)?.text;
    expect(lastDm('ana')).toBe(LINK);
    expect(lastDm('ben')).toBe('New link: https://example.com/v2');
  });

  it('lets an in-flight run finish after the automation is disabled, but starts no new ones', async () => {
    const { automationId } = await startConversation();
    await setEnabled(h.db, automationId, false);
    await h.comment('ben', 'pricing');
    await h.dm('ana', 'ana@example.com');
    await h.drain();
    expect((await h.runs()).map((r) => [r.contact_id, r.status])).toEqual([['ana', 'completed']]);
  });
});
