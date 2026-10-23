import { EventDispatcher } from './event-dispatcher.js';
import { ExpiryScheduler } from './scheduler.js';
import type { EngineDeps } from './step-context.js';
import { Worker, type WorkerOptions } from './worker.js';

export interface EngineOptions {
  /** Concurrent worker loops in this process. */
  workers?: number;
  /** How long the dispatcher and workers sleep when they find nothing to do. */
  pollMs?: number;
  schedulerPollMs?: number;
  worker?: WorkerOptions;
  onError?: (err: unknown) => void;
}

export interface Engine {
  /** Stops polling and resolves once every loop has finished its current tick. */
  stop(): Promise<void>;
}

/**
 * Runs the dispatcher, workers, and expiry scheduler as polling loops. A loop
 * goes straight to its next tick while there is work, and sleeps when idle.
 */
export function startEngine(deps: EngineDeps, opts: EngineOptions = {}): Engine {
  const pollMs = opts.pollMs ?? 500;
  const onError = opts.onError ?? ((err) => console.error('engine tick failed', err));
  const stopping = new AbortController();

  const dispatcher = new EventDispatcher(deps, { onError });
  const scheduler = new ExpiryScheduler(deps);
  const loops = [
    loop(async () => (await dispatcher.tick()) > 0, pollMs),
    loop(async () => (await scheduler.tick()) > 0, opts.schedulerPollMs ?? 1_000),
    ...Array.from({ length: opts.workers ?? 4 }, () => {
      const worker = new Worker(deps, opts.worker);
      return loop(() => worker.tick(), pollMs);
    }),
  ];

  async function loop(tick: () => Promise<boolean>, idleMs: number): Promise<void> {
    while (!stopping.signal.aborted) {
      let busy = false;
      try {
        busy = await tick();
      } catch (err) {
        onError(err);
      }
      if (!busy) await sleep(idleMs, stopping.signal);
    }
  }

  return {
    async stop() {
      stopping.abort();
      await Promise.all(loops);
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
