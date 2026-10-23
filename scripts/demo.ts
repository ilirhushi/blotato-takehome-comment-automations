import { createAutomation } from '../src/app/automations.js';
import { EventDispatcher } from '../src/app/event-dispatcher.js';
import { ingestEvent } from '../src/app/ingest.js';
import { ExpiryScheduler } from '../src/app/scheduler.js';
import { Worker } from '../src/app/worker.js';
import { FakeClock } from '../src/clock.js';
import type { NewInboundEvent } from '../src/core/inbound.js';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { MockPlatformClient } from '../src/platform/mock.js';

const SCHEMA = 'demo';
const contact = { accountId: 'acct-demo', platform: 'instagram', contactId: 'ana' } as const;

const admin = createPool();
await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
await admin.end();
const db = createPool({ searchPath: SCHEMA });
await migrate(db);

const clock = new FakeClock('2026-01-01T09:00:00Z');
const client = new MockPlatformClient();
const deps = { db, clock, client };
const dispatcher = new EventDispatcher(deps);
const worker = new Worker(deps);
const scheduler = new ExpiryScheduler(deps);

const time = () => clock.now().toISOString().slice(11, 19);
let printed = 0;
function printOutbound() {
  for (const m of client.sent.slice(printed)) {
    if (m.kind === 'comment_reply') console.log(`${time()}  bot   -> comment ${m.commentId}: "${m.text}"`);
    else console.log(`${time()}  bot   -> DM${m.replyToCommentId ? ' (private reply)' : ''}: "${m.text}"`);
  }
  printed = client.sent.length;
}

async function settle() {
  for (;;) {
    const dispatched = await dispatcher.tick();
    const worked = await worker.tick();
    await scheduler.tick();
    printOutbound();
    if (!dispatched && !worked) return;
  }
}

async function receive(event: Omit<NewInboundEvent, 'contact'>, label: string) {
  console.log(`${time()}  ana   -> ${label}`);
  await ingestEvent(db, clock, { ...event, contact } as NewInboundEvent);
  await settle();
}

async function printRun(heading: string) {
  const { rows } = await db.query(`SELECT status, current_step, context FROM runs`);
  const run = rows[0];
  console.log(`\n${heading}: status=${run.status} step=${run.current_step} vars=${JSON.stringify(run.context.vars)}\n`);
}

console.log('Seeding automation: comment "pricing" -> reply, ask for email, wait, send link\n');
await createAutomation(db, {
  accountId: contact.accountId,
  platform: 'instagram',
  trigger: { type: 'comment_keyword', keyword: 'pricing', post_ids: null },
  steps: [
    { type: 'reply_to_comment', text: 'Sent you a DM!' },
    { type: 'send_dm', text: 'Hi {{username}}! What email should we send pricing to?' },
    {
      type: 'wait_for_reply',
      validator: 'email',
      save_as: 'email',
      timeout_seconds: 24 * 60 * 60,
      max_reprompts: 2,
      reprompt_text: "Hmm, that doesn't look like an email. Could you double-check it?",
      give_up_text: 'No worries! Comment "pricing" again any time.',
    },
    { type: 'send_dm', text: 'Thanks! Here is our pricing: https://example.com/pricing (copy sent to {{email}})' },
  ],
});

await receive(
  {
    kind: 'comment',
    platformEventId: 'comment-1',
    payload: {
      comment_id: 'comment-1',
      post_id: 'post-42',
      text: 'What is the pricing?',
      username: 'ana',
      created_at: clock.now().toISOString(),
    },
  },
  'comment on post-42: "What is the pricing?"',
);
await printRun('Run after the comment');

clock.advance(2 * 60_000);
await receive({ kind: 'dm', platformEventId: 'dm-1', payload: { message_id: 'dm-1', text: 'ana at example dot com' } }, 'DM: "ana at example dot com"');

clock.advance(60_000);
await receive({ kind: 'dm', platformEventId: 'dm-2', payload: { message_id: 'dm-2', text: 'ana@example.com' } }, 'DM: "ana@example.com"');

clock.advance(60_000);
console.log(`${time()}  (the platform re-delivers the last DM webhook)`);
const duplicate = await ingestEvent(db, clock, {
  kind: 'dm',
  platformEventId: 'dm-2',
  contact,
  payload: { message_id: 'dm-2', text: 'ana@example.com' },
});
console.log(`${time()}  duplicate ignored: ${duplicate === null}`);
await settle();

await printRun('Final run');
const { rows } = await db.query(
  `SELECT step_index, effect_key, attempt, status FROM step_executions ORDER BY id`,
);
console.log('Side effects recorded in step_executions:');
console.table(rows);

await db.end();
