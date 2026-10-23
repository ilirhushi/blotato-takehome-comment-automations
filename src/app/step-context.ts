import type { Clock } from '../clock.js';
import type { Lease, Run, RunContext, WaitState } from '../core/run.js';
import type { WaitForReplyStep } from '../core/types.js';
import type { Db } from '../db/pool.js';
import type { Reply } from '../core/run.js';
import { dmText } from '../core/inbound.js';
import type { PlatformAdapter, PlatformClient } from '../platform/types.js';
import * as events from '../store/events.js';
import * as stepExecutions from '../store/step-executions.js';
import type { Channel, PendingAttempt, SentEffect } from '../store/step-executions.js';
import { LeaseLostError, PermanentStepError, SendTimeoutError } from './errors.js';

export interface EngineDeps {
  db: Db;
  clock: Clock;
  client: PlatformClient;
}

export interface SendLimits {
  maxAttempts: number;
  timeoutMs: number;
}

/** consumed lists inbound DMs the step used, marked consumed together with the run update. */
export type StepResult =
  | { type: 'advance'; context?: RunContext; consumed?: string[] }
  | { type: 'stay'; context: RunContext; consumed?: string[] }
  | { type: 'complete'; context: RunContext; consumed?: string[] }
  | { type: 'wait'; step: WaitForReplyStep; wait: WaitState }
  /** The give-up message was sent. The worker rechecks for a late valid answer before ending the run. */
  | { type: 'give_up'; step: WaitForReplyStep; wait: WaitState; context: RunContext; consumed: string[] };

export class StepContext {
  constructor(
    readonly deps: EngineDeps,
    readonly adapter: PlatformAdapter,
    readonly run: Run,
    readonly lease: Lease,
    private readonly limits: SendLimits,
  ) {}

  get client(): PlatformClient {
    return this.deps.client;
  }

  now(): Date {
    return this.deps.clock.now();
  }

  lastInboundDmAt(): Promise<Date | null> {
    return events.lastDmAt(this.deps.db, this.run.contact);
  }

  latestSentAt(): Promise<Date | null> {
    return stepExecutions.latestSentAt(this.deps.db, this.run.id);
  }

  async unconsumedDmsSince(since: Date): Promise<Reply[]> {
    const dms = await events.unconsumedDmsSince(this.deps.db, this.run.contact, since);
    return dms.map((dm) => ({ eventId: dm.id, text: dmText(dm) }));
  }

  /**
   * Records the side effect as pending, performs it, then records it as sent.
   * A send already marked sent is not repeated. A crash between the platform
   * call and marking it sent leaves it pending, and the retry sends it again.
   * The call is abandoned after the timeout, so it cannot outlive the lease.
   * A replay reports how the effect was actually delivered.
   */
  async send(
    effectKey: string,
    channel: Channel,
    perform: (signal: AbortSignal, pending: PendingAttempt) => Promise<{ messageId: string | null }>,
  ): Promise<SentEffect> {
    const { db } = this.deps;
    const key = { runId: this.run.id, stepIndex: this.run.currentStep, effectKey };

    const sent = await stepExecutions.findSent(db, key);
    if (sent) return sent;

    const pending = await stepExecutions.markPending(db, this.lease, key, channel, this.now());
    if (pending === null) throw new LeaseLostError(`lease lost on run ${this.run.id}`);
    const { attempt } = pending;
    // Only reachable when earlier attempts died without recording a failure.
    if (attempt > this.limits.maxAttempts) {
      const reason = `gave up after ${attempt - 1} attempts`;
      await stepExecutions.markFailed(db, key, attempt, reason, false, this.now());
      throw new PermanentStepError(reason);
    }

    let result: { messageId: string | null };
    try {
      result = await withTimeout((signal) => perform(signal, pending), this.limits.timeoutMs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await stepExecutions.markFailed(db, key, attempt, message, err instanceof SendTimeoutError, this.now());
      throw err;
    }
    return stepExecutions.markSent(db, key, attempt, result.messageId, this.now());
  }
}

async function withTimeout<T>(perform: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SendTimeoutError(`platform call timed out after ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([perform(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
