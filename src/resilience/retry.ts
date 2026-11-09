/**
 * Retries with exponential backoff and *full jitter*, bounded by a total time budget.
 *
 *   delay(n) = random(0, min(maxDelay, base * 2^(n-1)))
 *
 * The budget matters as much as the jitter: without it, retries pile up behind an
 * outage (retry storm) and the caller's own timeout fires anyway. An attempt is
 * only started if it can get at least `minAttemptMs` of the remaining budget, and
 * each attempt's timeout is clipped to what is left.
 */
export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Total wall-clock budget for all attempts and waits. */
  budgetMs: number;
  /** Per-attempt timeout (clipped to the remaining budget). */
  attemptTimeoutMs: number;
  /** Don't start an attempt with less time than this left. */
  minAttemptMs?: number;
}

export interface RetryDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface RetryOutcome<T> {
  value: T;
  attempts: number;
}

export function fullJitterDelay(attempt: number, policy: Pick<RetryPolicy, 'baseDelayMs' | 'maxDelayMs'>, random = Math.random): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs `fn` until it succeeds, `shouldRetry` says no, attempts run out, or the
 * budget is spent. The original error is re-thrown (not wrapped) so callers can
 * map it; the attempt count is attached as `err.attempts`.
 */
export async function retryWithBudget<T>(
  fn: (attempt: number, timeoutMs: number) => Promise<T>,
  policy: RetryPolicy,
  shouldRetry: (err: unknown, attempt: number) => boolean,
  deps: RetryDeps = {},
): Promise<RetryOutcome<T>> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const minAttempt = policy.minAttemptMs ?? 250;
  const deadline = now() + policy.budgetMs;

  for (let attempt = 1; ; attempt++) {
    const remaining = deadline - now();
    const timeoutMs = Math.min(policy.attemptTimeoutMs, remaining);
    try {
      const value = await fn(attempt, timeoutMs);
      return { value, attempts: attempt };
    } catch (err) {
      const canRetry = attempt < policy.maxAttempts && shouldRetry(err, attempt);
      if (!canRetry) throw tagAttempts(err, attempt);
      const delay = fullJitterDelay(attempt, policy, random);
      if (now() + delay + minAttempt > deadline) throw tagAttempts(err, attempt);
      await sleep(delay);
    }
  }
}

function tagAttempts(err: unknown, attempts: number): unknown {
  if (err && typeof err === 'object') (err as { attempts?: number }).attempts = attempts;
  return err;
}
