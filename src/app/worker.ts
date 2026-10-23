import { acceptReply, afterGiveUp, enterWait, firstValidValue } from '../core/conversation.js';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from '../core/retry.js';
import { dmText } from '../core/inbound.js';
import { advance, complete, onStepFailure, stay, type Lease, type Run, type RunUpdate } from '../core/run.js';
import type { Step } from '../core/types.js';
import { isTransientDbError } from '../db/errors.js';
import { withTransaction, type Tx } from '../db/pool.js';
import { getAdapter } from '../platform/index.js';
import { TransientPlatformError } from '../platform/types.js';
import * as automations from '../store/automations.js';
import * as events from '../store/events.js';
import { lockContact } from '../store/locks.js';
import * as runs from '../store/runs.js';
import { LeaseLostError } from './errors.js';
import { executeStep } from './executors.js';
import { StepContext, type EngineDeps, type StepResult } from './step-context.js';

export interface WorkerOptions {
  leaseMs?: number;
  /** Must be well under leaseMs, so a hung platform call is abandoned before another worker can claim the run. */
  sendTimeoutMs?: number;
  retryPolicy?: RetryPolicy;
  random?: () => number;
}

export class Worker {
  private readonly leaseMs: number;
  private readonly sendTimeoutMs: number;
  private readonly retryPolicy: RetryPolicy;
  private readonly random: () => number;
  // Versions are immutable, so caching them never serves stale steps.
  private readonly stepsByVersion = new Map<string, Step[]>();

  constructor(
    private readonly deps: EngineDeps,
    opts: WorkerOptions = {},
  ) {
    this.leaseMs = opts.leaseMs ?? 30_000;
    this.sendTimeoutMs = opts.sendTimeoutMs ?? 10_000;
    if (this.sendTimeoutMs >= this.leaseMs) throw new Error('sendTimeoutMs must be shorter than leaseMs');
    this.retryPolicy = opts.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.random = opts.random ?? Math.random;
  }

  /** Claims one runnable run and executes its current step. Returns false if there was nothing to do. */
  async tick(): Promise<boolean> {
    const { db, clock } = this.deps;
    const now = clock.now();
    const run = await runs.claimRunnable(db, now, new Date(now.getTime() + this.leaseMs));
    if (!run) return false;

    const lease = { runId: run.id, until: run.leaseUntil! };
    const steps = await this.stepsOf(run.versionId);
    const ctx = new StepContext(this.deps, getAdapter(run.contact.platform), run, lease, {
      maxAttempts: this.retryPolicy.maxAttempts,
      timeoutMs: this.sendTimeoutMs,
    });
    try {
      const result = await executeStep(ctx, steps[run.currentStep]!);
      await this.apply(run, lease, steps.length, result);
    } catch (err) {
      if (err instanceof LeaseLostError) return true;
      const decision = onStepFailure(
        {
          transient: err instanceof TransientPlatformError || isTransientDbError(err),
          message: err instanceof Error ? err.message : String(err),
          attempt: run.failures + 1,
        },
        this.retryPolicy,
        clock.now(),
        this.random,
      );
      // Other errors are treated as permanent: retrying a bug only hides it.
      // If the database is still down this write fails too, and the expired lease
      // makes the run claimable again.
      if (decision.kind === 'retry') await runs.rescheduleIfLeaseHeld(db, lease, decision.wakeAt, clock.now());
      else await runs.failIfLeaseHeld(db, lease, decision.reason, clock.now());
    }
    return true;
  }

  private async apply(run: Run, lease: Lease, stepCount: number, result: StepResult): Promise<void> {
    const { db, clock } = this.deps;
    if (result.type === 'wait') {
      // Under the contact lock, so a DM is either seen here or by the dispatcher after we commit.
      await withTransaction(db, async (tx) => {
        await lockContact(tx, run.contact);
        const [dm] = await events.unconsumedDmsSince(tx, run.contact, new Date(result.wait.since));
        const reply = dm ? { eventId: dm.id, text: dmText(dm) } : null;
        const update = enterWait(run, result.step, result.wait, reply, clock.now());
        await this.applyAndConsume(tx, run, lease, update, dm ? [dm.id] : []);
      });
      return;
    }
    if (result.type === 'give_up') {
      // Under the contact lock, so a DM that arrives after this check finds the run already ended.
      await withTransaction(db, async (tx) => {
        await lockContact(tx, run.contact);
        const dms = await events.unconsumedDmsSince(tx, run.contact, new Date(result.wait.since));
        const late = dms.filter((dm) => !result.consumed.includes(dm.id));
        const value = firstValidValue(result.step, late.map(dmText));
        const update =
          value === null
            ? complete(run, afterGiveUp(result.context))
            : advance(run, stepCount, acceptReply(result.context, result.step, value), clock.now());
        await this.applyAndConsume(tx, run, lease, update, [...result.consumed, ...late.map((dm) => dm.id)]);
      });
      return;
    }
    const update: RunUpdate =
      result.type === 'advance'
        ? advance(run, stepCount, result.context ?? run.context, clock.now())
        : result.type === 'stay'
          ? stay(run, result.context, clock.now())
          : complete(run, result.context);
    if (!result.consumed?.length) {
      await runs.applyIfLeaseHeld(db, lease, update, clock.now());
      return;
    }
    await withTransaction(db, async (tx) => {
      await lockContact(tx, run.contact);
      await this.applyAndConsume(tx, run, lease, update, result.consumed!);
    });
  }

  /** Rolls back the caller's transaction, including the consumption, if the lease was lost. */
  private async applyAndConsume(tx: Tx, run: Run, lease: Lease, update: RunUpdate, eventIds: string[]): Promise<void> {
    if (!(await runs.applyIfLeaseHeld(tx, lease, update, this.deps.clock.now()))) {
      throw new LeaseLostError(`lease lost on run ${run.id}`);
    }
    for (const id of eventIds) await events.markConsumed(tx, id, run.id);
  }

  private async stepsOf(versionId: string): Promise<Step[]> {
    let steps = this.stepsByVersion.get(versionId);
    if (!steps) {
      steps = await automations.stepsOfVersion(this.deps.db, versionId);
      this.stepsByVersion.set(versionId, steps);
    }
    return steps;
  }
}
