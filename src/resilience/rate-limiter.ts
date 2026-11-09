/**
 * Gateway-side admission control for the legacy host (the bulkhead).
 *
 * RESLINK accepts 5 req/s across all callers and answers "9001 busy" beyond that.
 * If the gateway just sends and retries, a cold cache turns into a retry storm:
 * misses exceed the limit, every busy answer is retried, which adds even more load.
 * So every legacy call (including retries and background refreshes) first takes a
 * slot in a shared one-second window: an atomic counter in DynamoDB, so all Lambda
 * instances share one budget. A call that finds the window full waits for the next
 * one, up to its own deadline, then gives up with LegacyBusyError (503) without
 * touching the host.
 */
import type { KvStore } from '../store/kv';

export class LegacyBusyError extends Error {
  override name = 'LegacyBusyError';
  constructor() {
    super('gateway-side rate limit for the legacy host reached');
  }
}

export interface RateLimiterOptions {
  name: string;
  /** Calls per second across the whole fleet. 0 disables the limiter. */
  perSecond: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export class WindowRateLimiter {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(
    private readonly store: KvStore,
    private readonly opts: RateLimiterOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
  }

  /** Resolves when a slot is taken; throws LegacyBusyError if none is free before `deadline`. */
  async acquire(deadline: number): Promise<void> {
    if (this.opts.perSecond <= 0) return;
    for (;;) {
      const now = this.now();
      const second = Math.floor(now / 1000);
      let n: number;
      try {
        n = await this.store.increment(`RATE#${this.opts.name}#${second}`, second + 120);
      } catch {
        return; // limiter state unavailable: fail open rather than block all traffic
      }
      if (n <= this.opts.perSecond) return;
      // Window full: wait for the next one (with jitter so waiters don't stampede together).
      const wait = (second + 1) * 1000 - now + Math.floor(this.random() * 200);
      if (this.now() + wait >= deadline) throw new LegacyBusyError();
      await this.sleep(wait);
    }
  }
}
