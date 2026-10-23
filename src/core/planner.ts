import type { CommentPayload } from './inbound.js';
import { initialContext, type RunContext } from './run.js';
import { triggerMatches } from './trigger.js';
import type { Trigger } from './types.js';

export interface CandidateAutomation {
  automationId: string;
  versionId: string;
  trigger: Trigger;
}

export interface PlannedRun {
  automationId: string;
  versionId: string;
  status: 'running' | 'skipped';
  context: RunContext;
}

/**
 * Decides which runs a comment creates. A contact has at most one active run,
 * so only the first match starts, and only if the contact is not already busy.
 * The rest are recorded as skipped, with the reason.
 */
export function planRunsForComment(
  candidates: CandidateAutomation[],
  comment: CommentPayload,
  contactBusy: boolean,
): PlannedRun[] {
  const matches = candidates.filter((c) => triggerMatches(c.trigger, { post_id: comment.post_id, text: comment.text }));
  return matches.map((m, i) => {
    const starts = !contactBusy && i === 0;
    const context = initialContext(comment);
    return {
      automationId: m.automationId,
      versionId: m.versionId,
      status: starts ? 'running' : 'skipped',
      context: starts ? context : { ...context, outcome: contactBusy ? 'contact_busy' : 'another_automation_matched' },
    };
  });
}
