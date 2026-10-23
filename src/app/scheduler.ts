import type { Clock } from '../clock.js';
import type { Db } from '../db/pool.js';
import { expireDue } from '../store/runs.js';

/** Expires waiting runs whose reply deadline has passed. */
export class ExpiryScheduler {
  constructor(private readonly deps: { db: Db; clock: Clock }) {}

  /** Returns the number of runs expired. */
  tick(): Promise<number> {
    return expireDue(this.deps.db, this.deps.clock.now());
  }
}
