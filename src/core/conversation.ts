import { validateReply } from './reply-validators.js';
import { stay, type Reply, type Run, type RunContext, type RunUpdate, type WaitState } from './run.js';
import type { WaitForReplyStep } from './types.js';

export type ReplyDecision =
  | { kind: 'accept'; value: string }
  | { kind: 'reprompt'; number: number }
  | { kind: 'give_up' };

export function firstValidValue(step: WaitForReplyStep, texts: string[]): string | null {
  for (const text of texts) {
    const value = validateReply(step.validator, text);
    if (value !== null) return value;
  }
  return null;
}

/** Messages that arrived together count as one answer: the first valid value wins, otherwise one re-prompt. */
export function decideOnReplies(step: WaitForReplyStep, wait: WaitState, texts: string[]): ReplyDecision {
  const value = firstValidValue(step, texts);
  if (value !== null) return { kind: 'accept', value };
  if (wait.reprompts < step.max_reprompts) return { kind: 'reprompt', number: wait.reprompts + 1 };
  return { kind: 'give_up' };
}

export function acceptReply(context: RunContext, step: WaitForReplyStep, value: string): RunContext {
  return { ...context, vars: { ...context.vars, [step.save_as]: value } };
}

export function afterReprompt(context: RunContext, wait: WaitState, number: number): RunContext {
  return { ...context, wait: { since: wait.since, reprompts: number } };
}

export function afterGiveUp(context: RunContext): RunContext {
  return { ...context, outcome: 'gave_up' };
}

/**
 * Either takes a reply that arrived before the run started waiting, or parks
 * the run until a reply or the deadline. Each (re)entry resets the deadline.
 */
export function enterWait(
  run: Pick<Run, 'currentStep' | 'context'>,
  step: WaitForReplyStep,
  wait: WaitState,
  earlyReply: Reply | null,
  now: Date,
): RunUpdate {
  if (earlyReply) return stay(run, { ...run.context, wait: { ...wait, reply: earlyReply } }, now);
  return {
    currentStep: run.currentStep,
    status: 'waiting',
    context: { ...run.context, wait },
    wakeAt: new Date(now.getTime() + step.timeout_seconds * 1000),
    waitingSince: now,
  };
}

/** A DM can answer the wait only if it arrived after the prompt and before the deadline. */
export function canAnswer(
  run: Pick<Run, 'context' | 'wakeAt'>,
  receivedAt: Date,
): run is Pick<Run, 'wakeAt'> & { context: RunContext & { wait: WaitState } } {
  const { wait } = run.context;
  if (!wait || !run.wakeAt) return false;
  return receivedAt.getTime() >= new Date(wait.since).getTime() && receivedAt < run.wakeAt;
}

export function resumeWithReply(run: Pick<Run, 'currentStep' | 'context'>, wait: WaitState, reply: Reply, now: Date) {
  return stay(run, { ...run.context, wait: { ...wait, reply } }, now);
}
