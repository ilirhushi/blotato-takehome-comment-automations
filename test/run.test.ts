import { describe, expect, it } from 'vitest';
import { advance, onStepFailure, type RunContext } from '../src/core/run.js';

const now = new Date('2026-01-01T00:00:00Z');
const context: RunContext = { vars: {}, comment: { id: 'c', post_id: 'p', created_at: now.toISOString() } };
const policy = { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 3_000 };

describe('advance', () => {
  it('keeps the run going until the last step', () => {
    expect(advance({ currentStep: 0 }, 2, context, now)).toEqual({ status: 'running', context, wakeAt: now });
    expect(advance({ currentStep: 1 }, 2, context, now)).toEqual({ status: 'completed', context, wakeAt: null });
  });
});

describe('onStepFailure', () => {
  const at = (ms: number) => new Date(now.getTime() + ms);

  it('fails permanent errors immediately', () => {
    expect(onStepFailure({ transient: false, message: 'gone', attempt: 1 }, policy, now, () => 1)).toEqual({
      kind: 'fail',
      reason: 'gone',
    });
  });

  it('retries transient errors with capped exponential backoff', () => {
    const retry = (attempt: number) => onStepFailure({ transient: true, message: '503', attempt }, policy, now, () => 1);
    expect(retry(1)).toEqual({ kind: 'retry', wakeAt: at(1_000) });
    expect(retry(2)).toEqual({ kind: 'retry', wakeAt: at(2_000) });
  });

  it('applies jitter within the backoff ceiling', () => {
    expect(onStepFailure({ transient: true, message: '503', attempt: 2 }, policy, now, () => 0.25)).toEqual({
      kind: 'retry',
      wakeAt: at(500),
    });
  });

  it('gives up after the last attempt', () => {
    expect(onStepFailure({ transient: true, message: '503', attempt: 3 }, policy, now, () => 1)).toEqual({
      kind: 'fail',
      reason: 'gave up after 3 attempts: 503',
    });
  });
});
