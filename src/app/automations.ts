import type { Platform } from '../core/types.js';
import { validateVersion } from '../core/validate.js';
import { withTransaction, type Db } from '../db/pool.js';
import * as automations from '../store/automations.js';

export async function createAutomation(
  db: Db,
  input: { accountId: string; platform: Platform; trigger: unknown; steps: unknown },
): Promise<{ automationId: string; versionId: string }> {
  const { trigger, steps } = validateVersion(input.trigger, input.steps);
  return withTransaction(db, async (tx) => {
    const automationId = await automations.insertAutomation(tx, input.accountId, input.platform);
    const versionId = await automations.insertCurrentVersion(tx, automationId, trigger, steps);
    return { automationId, versionId };
  });
}

export async function publishVersion(db: Db, automationId: string, rawTrigger: unknown, rawSteps: unknown) {
  const { trigger, steps } = validateVersion(rawTrigger, rawSteps);
  return withTransaction(db, (tx) => automations.insertCurrentVersion(tx, automationId, trigger, steps));
}
