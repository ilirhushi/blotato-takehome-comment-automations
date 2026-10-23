export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 5 * 60_000,
};

/** Exponential backoff with full jitter. attempt is the attempt that just failed, starting at 1. */
export function backoffMs(policy: RetryPolicy, attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}
