import type { CommentPayload } from './inbound.js';
import { backoffMs, type RetryPolicy } from './retry.js';
import type { ContactKey } from './types.js';

export type RunStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'expired' | 'skipped';

export interface RunContext {
  vars: Record<string, string>;
  comment: { id: string; post_id: string; created_at: string };
  private_reply_used?: boolean;
  outcome?: string;
  wait?: WaitState;
}

export interface Reply {
  eventId: string;
  text: string;
}

/** State of the current wait_for_reply step. Cleared when the run leaves it. */
export interface WaitState {
  /** Only DMs received at or after this ISO time can answer the wait. */
  since: string;
  reprompts: number;
  reply?: Reply;
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

/** The new state of a run after a step, applied only while the worker still holds the lease. */
export interface RunUpdate {
  currentStep: number;
  status: RunStatus;
  context: RunContext;
  wakeAt: Date | null;
  waitingSince: Date | null;
}

type RunPosition = Pick<Run, 'currentStep'>;

export function advance(run: RunPosition, stepCount: number, context: RunContext, now: Date): RunUpdate {
  const next = run.currentStep + 1;
  const { wait: _, ...rest } = context;
  return next >= stepCount
    ? { currentStep: next, status: 'completed', context: rest, wakeAt: null, waitingSince: null }
    : { currentStep: next, status: 'running', context: rest, wakeAt: now, waitingSince: null };
}

/** Runs the same step again on the next tick. */
export function stay(run: RunPosition, context: RunContext, now: Date): RunUpdate {
  return { currentStep: run.currentStep, status: 'running', context, wakeAt: now, waitingSince: null };
}

/** Ends the run without executing the remaining steps. */
export function complete(run: RunPosition, context: RunContext): RunUpdate {
  const { wait: _, ...rest } = context;
  return { currentStep: run.currentStep, status: 'completed', context: rest, wakeAt: null, waitingSince: null };
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
