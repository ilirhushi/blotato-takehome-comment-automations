import { randomUUID } from 'node:crypto';
import { createAutomation } from '../src/app/automations.js';
import { ingestEvent } from '../src/app/ingest.js';
import { systemClock } from '../src/clock.js';
import { createPool } from '../src/db/pool.js';
import { enabledForAccount } from '../src/store/automations.js';
import { pricingSteps, pricingTrigger } from './pricing-automation.js';

// Feeds events to a running engine (npm start), standing in for the platform's webhooks.
//   npm run seed -- comment [contact] [text]
//   npm run seed -- dm [contact] [text]

const ACCOUNT = 'acct-local';
const [kind = 'comment', contactId = 'ana', text] = process.argv.slice(2);
if (kind !== 'comment' && kind !== 'dm') {
  console.error('usage: npm run seed -- comment|dm [contact] [text]');
  process.exit(1);
}
const contact = { accountId: ACCOUNT, platform: 'instagram', contactId } as const;
const id = randomUUID();
const db = createPool();

if ((await enabledForAccount(db, contact)).length === 0) {
  await createAutomation(db, { accountId: ACCOUNT, platform: 'instagram', trigger: pricingTrigger, steps: pricingSteps });
  console.log(`created the pricing automation for ${ACCOUNT}`);
}

if (kind === 'comment') {
  const comment = text ?? 'What is the pricing?';
  await ingestEvent(db, systemClock, {
    contact,
    kind,
    platformEventId: id,
    payload: { comment_id: id, post_id: 'post-1', text: comment, username: contactId, created_at: new Date().toISOString() },
  });
  console.log(`${contactId} commented: "${comment}"`);
} else {
  const message = text ?? `${contactId}@example.com`;
  await ingestEvent(db, systemClock, { contact, kind, platformEventId: id, payload: { message_id: id, text: message } });
  console.log(`${contactId} sent a DM: "${message}"`);
}

await db.end();
