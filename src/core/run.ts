import type { CommentPayload } from './inbound.js';
import { backoffMs, type RetryPolicy } from './retry.js';
import type { ContactKey } from './types.js';

export type RunStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'expired' | 'skipped';

export interface RunContext {
  vars: Record<string, string>;
  comment: { id: string; post_id: string; created_at: string };
  private_reply_used?: boolean;
  outcome?: string;
}

export interface Run {
  id: string;
  automationId: string;
  versionId: string;
  contact: ContactKey;
  triggerEventId: string;
  status: RunStatus;
  currentStep: number;
  context: RunContext;
  wakeAt: Date | null;
  waitingSince: Date | null;
  leaseUntil: Date | null;
  error: string | null;
}

/** A worker's claim on a run. The until value doubles as a fencing token. */
export interface Lease {
  runId: string;
  until: Date;
}

export function initialContext(comment: CommentPayload): RunContext {
  return {
    vars: { username: comment.username, comment_text: comment.text },
    comment: { id: comment.comment_id, post_id: comment.post_id, created_at: comment.created_at },
  };
}

export interface Advance {
  status: 'running' | 'completed';
  context: RunContext;
  wakeAt: Date | null;
}

export function advance(run: Pick<Run, 'currentStep'>, stepCount: number, context: RunContext, now: Date): Advance {
  const isLast = run.currentStep + 1 >= stepCount;
  return isLast ? { status: 'completed', context, wakeAt: null } : { status: 'running', context, wakeAt: now };
}

export type FailureDecision = { kind: 'retry'; wakeAt: Date } | { kind: 'fail'; reason: string };

export interface StepFailure {
  transient: boolean;
  message: string;
  attempt: number;
}

export function onStepFailure(
  failure: StepFailure,
  policy: RetryPolicy,
  now: Date,
  random: () => number,
): FailureDecision {
  if (!failure.transient) return { kind: 'fail', reason: failure.message };
  if (failure.attempt >= policy.maxAttempts) {
    return { kind: 'fail', reason: `gave up after ${failure.attempt} attempts: ${failure.message}` };
  }
  return { kind: 'retry', wakeAt: new Date(now.getTime() + backoffMs(policy, failure.attempt, random)) };
}
