import type { Clock } from '../clock.js';
import type { Lease, Run, RunContext } from '../core/run.js';
import type { Db } from '../db/pool.js';
import type { PlatformAdapter, PlatformClient, SendResult } from '../platform/types.js';
import * as events from '../store/events.js';
import * as stepExecutions from '../store/step-executions.js';
import { LeaseLostError } from './errors.js';

export interface EngineDeps {
  db: Db;
  clock: Clock;
  client: PlatformClient;
}

export type StepResult = { type: 'advance'; context?: RunContext };

export class StepContext {
  /** Attempt number of the most recent send; the worker uses it to decide on retries. */
  lastAttempt = 0;

  constructor(
    readonly deps: EngineDeps,
    readonly adapter: PlatformAdapter,
    readonly run: Run,
    readonly lease: Lease,
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

  /**
   * Records the side effect as pending, performs it, then records it as sent.
   * A send already marked sent is not repeated. A crash between the platform
   * call and marking it sent leaves it pending, and the retry sends it again.
   */
  async send(effectKey: string, perform: () => Promise<SendResult>): Promise<SendResult> {
    const { db } = this.deps;
    const key = { runId: this.run.id, stepIndex: this.run.currentStep, effectKey };

    const sentId = await stepExecutions.findSent(db, key);
    if (sentId) return { messageId: sentId };

    const attempt = await stepExecutions.markPending(db, this.lease, key, this.now());
    if (attempt === null) throw new LeaseLostError(`lease lost on run ${this.run.id}`);
    this.lastAttempt = attempt;

    let result: SendResult;
    try {
      result = await perform();
    } catch (err) {
      await stepExecutions.markFailed(db, key, attempt, err instanceof Error ? err.message : String(err), this.now());
      throw err;
    }
    await stepExecutions.markSent(db, key, attempt, result.messageId, this.now());
    return result;
  }
}
