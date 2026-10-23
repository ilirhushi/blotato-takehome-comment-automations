import { describe, expect, it } from 'vitest';
import { canAnswer, decideOnReplies, enterWait } from '../src/core/conversation.js';
import type { RunContext, WaitState } from '../src/core/run.js';
import type { WaitForReplyStep } from '../src/core/types.js';

const step: WaitForReplyStep = {
  type: 'wait_for_reply',
  validator: 'email',
  save_as: 'email',
  timeout_seconds: 600,
  max_reprompts: 2,
  reprompt_text: 'again?',
  give_up_text: 'bye',
};
const now = new Date('2026-01-01T12:00:00Z');
const wait: WaitState = { since: '2026-01-01T11:00:00Z', reprompts: 0 };
const context: RunContext = { vars: {}, comment: { id: 'c', post_id: 'p', created_at: now.toISOString() } };

describe('decideOnReplies', () => {
  it('accepts a valid reply', () => {
    expect(decideOnReplies(step, wait, ['it is a@b.co'])).toEqual({ kind: 'accept', value: 'a@b.co' });
  });

  it('re-prompts until max_reprompts, then gives up', () => {
    expect(decideOnReplies(step, { ...wait, reprompts: 0 }, ['nope'])).toEqual({ kind: 'reprompt', number: 1 });
    expect(decideOnReplies(step, { ...wait, reprompts: 1 }, ['nope'])).toEqual({ kind: 'reprompt', number: 2 });
    expect(decideOnReplies(step, { ...wait, reprompts: 2 }, ['nope'])).toEqual({ kind: 'give_up' });
  });

  it('gives up on the first invalid reply when max_reprompts is 0', () => {
    expect(decideOnReplies({ ...step, max_reprompts: 0 }, wait, ['nope'])).toEqual({ kind: 'give_up' });
  });

  it('accepts the first valid reply in a burst', () => {
    expect(decideOnReplies(step, wait, ['hi!', 'one sec', 'a@b.co', 'c@d.co'])).toEqual({ kind: 'accept', value: 'a@b.co' });
  });

  it('counts a burst of invalid replies as one answer', () => {
    expect(decideOnReplies(step, wait, ['hi!', 'one sec', 'let me check'])).toEqual({ kind: 'reprompt', number: 1 });
  });
});

describe('enterWait', () => {
  it('parks the run with a deadline when no reply is available', () => {
    expect(enterWait({ currentStep: 2, context }, step, wait, null, now)).toEqual({
      currentStep: 2,
      status: 'waiting',
      context: { ...context, wait },
      wakeAt: new Date('2026-01-01T12:10:00Z'),
      waitingSince: now,
    });
  });

  it('takes a reply that arrived early and stays runnable', () => {
    const reply = { eventId: '9', text: 'a@b.co' };
    expect(enterWait({ currentStep: 2, context }, step, wait, reply, now)).toMatchObject({
      status: 'running',
      wakeAt: now,
      context: { wait: { ...wait, reply } },
    });
  });
});

describe('canAnswer', () => {
  const run = { context: { ...context, wait }, wakeAt: new Date('2026-01-01T12:00:00Z') };

  it('accepts DMs between the prompt and the deadline', () => {
    expect(canAnswer(run, new Date('2026-01-01T11:00:00Z'))).toBe(true);
    expect(canAnswer(run, new Date('2026-01-01T11:59:59Z'))).toBe(true);
  });

  it('rejects DMs from before the prompt or after the deadline', () => {
    expect(canAnswer(run, new Date('2026-01-01T10:59:59Z'))).toBe(false);
    expect(canAnswer(run, new Date('2026-01-01T12:00:00Z'))).toBe(false);
  });

  it('rejects runs that are not waiting on a reply', () => {
    expect(canAnswer({ context, wakeAt: run.wakeAt }, now)).toBe(false);
  });
});
