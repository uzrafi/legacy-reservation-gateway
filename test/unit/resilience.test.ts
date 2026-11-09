import { CircuitOpenError, isUpstreamHealthFailure, LegacyFaultError } from '../../src/lib/errors';
import { CircuitBreaker, KvSharedBreakerState } from '../../src/resilience/circuit-breaker';
import { LegacyBusyError, WindowRateLimiter } from '../../src/resilience/rate-limiter';
import { fullJitterDelay, retryWithBudget } from '../../src/resilience/retry';
import { MemoryKvStore } from '../../src/store/kv';

describe('retryWithBudget', () => {
  const policy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000, attemptTimeoutMs: 2000, budgetMs: 5000, minAttemptMs: 250 };

  test('full jitter stays inside [0, min(cap, base * 2^(n-1)))', () => {
    expect(fullJitterDelay(1, policy, () => 0.999)).toBe(99);
    expect(fullJitterDelay(3, policy, () => 0.5)).toBe(200);
    expect(fullJitterDelay(10, policy, () => 0.999)).toBe(999); // capped
    expect(fullJitterDelay(4, policy, () => 0)).toBe(0);
  });

  test('stops when the budget cannot fit another attempt', async () => {
    let t = 0;
    const attempts: number[] = [];
    const err = await retryWithBudget(
      async (attempt, timeoutMs) => {
        attempts.push(timeoutMs);
        t += 2000; // each attempt burns its full timeout
        throw new Error(`fail ${attempt}`);
      },
      policy,
      () => true,
      { now: () => t, sleep: async (ms) => void (t += ms), random: () => 1 },
    ).catch((e) => e);
    // t=0: 2000 timeout; t=2100: 2000; t=4300: 700 left -> clipped attempt; then no budget.
    expect(attempts).toEqual([2000, 2000, 700]);
    expect((err as { attempts: number }).attempts).toBe(3);
  });

  test('does not retry when shouldRetry says no', async () => {
    let n = 0;
    await expect(
      retryWithBudget(async () => {
        n++;
        throw new Error('business');
      }, policy, () => false),
    ).rejects.toThrow('business');
    expect(n).toBe(1);
  });
});

describe('CircuitBreaker', () => {
  const opts = { name: 'legacy', failureThreshold: 3, failureRateThreshold: 0.5, windowMs: 10_000, cooldownMs: 15_000 };

  async function fail(b: CircuitBreaker, n: number) {
    for (let i = 0; i < n; i++) await b.recordFailure(await b.acquire());
  }

  test('trips after N failures in the window, then half-opens for a single probe', async () => {
    let now = 0;
    const b = new CircuitBreaker({ ...opts, now: () => now });
    await fail(b, 3);
    expect(b.state).toBe('open');
    await expect(b.acquire()).rejects.toBeInstanceOf(CircuitOpenError);

    now = 15_001;
    const probe = await b.acquire();
    expect(probe).toEqual({ state: 'half-open', probe: true });
    await expect(b.acquire()).rejects.toBeInstanceOf(CircuitOpenError); // only one probe in flight
    await b.recordSuccess(probe);
    expect(b.state).toBe('closed');
    expect((await b.acquire()).state).toBe('closed');
  });

  test('a failed probe re-opens for another cool-down', async () => {
    let now = 0;
    const b = new CircuitBreaker({ ...opts, now: () => now });
    await fail(b, 3);
    now = 15_001;
    await b.recordFailure(await b.acquire());
    expect(b.state).toBe('open');
    now = 20_000;
    await expect(b.acquire()).rejects.toBeInstanceOf(CircuitOpenError);
  });

  test('failures outside the window are forgotten; mostly-successful traffic does not trip', async () => {
    let now = 0;
    const b = new CircuitBreaker({ ...opts, now: () => now });
    await fail(b, 2);
    now = 11_000;
    await fail(b, 2);
    expect(b.state).toBe('closed');
    for (let i = 0; i < 10; i++) await b.recordSuccess(await b.acquire());
    await fail(b, 1); // 3 failures in window but rate 3/13 < 50%
    expect(b.state).toBe('closed');
  });

  test('shared state: when one instance trips, the others back off too, and only one probes', async () => {
    let now = 0;
    const shared = new KvSharedBreakerState(new MemoryKvStore());
    const a = new CircuitBreaker({ ...opts, shared, sharedCacheMs: 1000, now: () => now });
    const b = new CircuitBreaker({ ...opts, shared, sharedCacheMs: 1000, now: () => now });
    const fresh = new CircuitBreaker({ ...opts, shared, sharedCacheMs: 1000, now: () => now }); // a cold-started instance

    await fail(a, 3);
    now = 1500; // past b's shared-flag cache
    await expect(b.acquire()).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(fresh.acquire()).rejects.toBeInstanceOf(CircuitOpenError);

    now = 16_000;
    const probeA = await a.acquire();
    expect(probeA.probe).toBe(true);
    await expect(b.acquire()).rejects.toBeInstanceOf(CircuitOpenError); // lease held by a
    await a.recordSuccess(probeA);
    now = 17_100;
    expect((await b.acquire()).state).toBe('closed');
    expect((await fresh.acquire()).state).toBe('closed');
  });

  test('instance-local state alone lets a cold instance hammer the host', async () => {
    const now = 0;
    const a = new CircuitBreaker({ ...opts, now: () => now });
    const fresh = new CircuitBreaker({ ...opts, now: () => now });
    await fail(a, 3);
    expect(a.state).toBe('open');
    expect((await fresh.acquire()).state).toBe('closed'); // the problem shared state solves
  });
});

describe('WindowRateLimiter (gateway-side admission control)', () => {
  function setup(perSecond: number) {
    let now = 10_000;
    const store = new MemoryKvStore();
    const limiter = new WindowRateLimiter(store, { name: 'h', perSecond, now: () => now, sleep: async (ms) => void (now += ms), random: () => 0 });
    return { limiter, at: () => now, set: (t: number) => (now = t) };
  }

  test('admits N calls per second, then makes the next one wait for the next window', async () => {
    const { limiter, at } = setup(5);
    for (let i = 0; i < 5; i++) await limiter.acquire(at() + 5000);
    expect(at()).toBe(10_000);
    await limiter.acquire(at() + 5000);
    expect(at()).toBe(11_000); // waited for the next window instead of hitting the host
  });

  test('sheds the call (without touching the host) when no slot frees up before the deadline', async () => {
    const { limiter, at } = setup(1);
    await limiter.acquire(at() + 5000);
    await expect(limiter.acquire(at() + 500)).rejects.toBeInstanceOf(LegacyBusyError);
  });

  test('0 disables it', async () => {
    const { limiter, at } = setup(0);
    for (let i = 0; i < 100; i++) await limiter.acquire(at());
  });

  test('"9001 busy" is backpressure, not ill health: it does not count against the breaker', () => {
    expect(isUpstreamHealthFailure(new LegacyFaultError(9001, 'BUSY'))).toBe(false);
    expect(isUpstreamHealthFailure(new LegacyFaultError(9002, 'DOWN'))).toBe(true);
  });
});
