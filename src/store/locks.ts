import type { ContactKey } from '../core/types.js';
import type { Tx } from '../db/pool.js';

const lockText = (k: ContactKey) => JSON.stringify([k.accountId, k.platform, k.contactId]);

export async function tryLockContact(tx: Tx, key: ContactKey): Promise<boolean> {
  const { rows } = await tx.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked',
    [lockText(key)],
  );
  return rows[0]!.locked;
}

export async function lockContact(tx: Tx, key: ContactKey): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockText(key)]);
}
