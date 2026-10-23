import { enterWait } from '../core/conversation.js';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from '../core/retry.js';
import { advance, complete, onStepFailure, stay, type Lease, type Run, type RunUpdate } from '../core/run.js';
import type { Step } from '../core/types.js';
import { withTransaction } from '../db/pool.js';
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
  retryPolicy?: RetryPolicy;
  random?: () => number;
}

export class Worker {
  private readonly leaseMs: number;
  private readonly retryPolicy: RetryPolicy;
  private readonly random: () => number;
  // Versions are immutable, so caching them never serves stale steps.
  private readonly stepsByVersion = new Map<string, Step[]>();

  constructor(
    private readonly deps: EngineDeps,
    opts: WorkerOptions = {},
  ) {
    this.leaseMs = opts.leaseMs ?? 30_000;
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
    const ctx = new StepContext(this.deps, getAdapter(run.contact.platform), run, lease);
    try {
      const result = await executeStep(ctx, steps[run.currentStep]!);
      await this.apply(run, lease, steps.length, result);
    } catch (err) {
      if (err instanceof LeaseLostError) return true;
      const decision = onStepFailure(
        {
          transient: err instanceof TransientPlatformError,
          message: err instanceof Error ? err.message : String(err),
          attempt: ctx.lastAttempt,
        },
        this.retryPolicy,
        clock.now(),
        this.random,
      );
      // Unexpected errors are treated as permanent: retrying a bug only hides it.
      // If the database itself is down this write fails too, and the expired lease
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
        const dm = await events.oldestUnconsumedDmSince(tx, run.contact, new Date(result.wait.since));
        const reply = dm && { eventId: dm.id, text: dm.payload.text };
        if (!(await runs.applyIfLeaseHeld(tx, lease, enterWait(run, result.step, result.wait, reply, clock.now()), clock.now()))) {
          throw new LeaseLostError(`lease lost on run ${run.id}`);
        }
        if (dm) await events.markConsumed(tx, dm.id, run.id);
      });
      return;
    }
    const update: RunUpdate =
      result.type === 'advance'
        ? advance(run, stepCount, result.context ?? run.context, clock.now())
        : result.type === 'stay'
          ? stay(run, result.context, clock.now())
          : complete(run, result.context);
    await runs.applyIfLeaseHeld(db, lease, update, clock.now());
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
