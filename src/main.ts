import { randomUUID } from 'node:crypto';
import { startEngine } from './app/runner.js';
import { systemClock } from './clock.js';
import { createPool } from './db/pool.js';
import type { PlatformClient } from './platform/types.js';

// Placeholder: the real platform client plugs in here. This one only logs what would be sent.
const consoleClient: PlatformClient = {
  async replyToComment(input) {
    console.log('reply_to_comment', input);
    return { messageId: randomUUID() };
  },
  async sendDm(input) {
    console.log('send_dm', input);
    return { messageId: randomUUID() };
  },
};

const db = createPool();
const engine = startEngine(
  { db, clock: systemClock, client: consoleClient },
  { workers: Number(process.env.WORKERS ?? 4) },
);
console.log('engine started');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    console.log(`${signal}: finishing in-flight steps`);
    await engine.stop();
    await db.end();
    console.log('engine stopped');
  });
}
