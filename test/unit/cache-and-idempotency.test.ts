import { withIdempotency } from '../../src/app/idempotency';
import { ReadThroughCache } from '../../src/cache/read-through';
import { HttpError, LegacyFaultError, UpstreamUnavailableError } from '../../src/lib/errors';
import { json } from '../../src/lib/http';
import { MemoryKvStore } from '../../src/store/kv';

describe('ReadThroughCache (stale-while-revalidate)', () => {
  const policy = { freshMs: 60_000, ttlSeconds: 3600 };

  function setup() {
    let now = 1_000_000;
    const store = new MemoryKvStore();
    const cache = new ReadThroughCache(store, () => now);
    const dispatched: string[] = [];
    const revalidate = async (k: string) => void dispatched.push(k);
    return { store, cache, dispatched, revalidate, tick: (ms: number) => (now += ms) };
  }

  test('miss -> loads and stores; then hits until freshUntil', async () => {
    const { cache, revalidate, tick } = setup();
    const loader = jest.fn(async () => 42);
    expect(await cache.get('k', loader, policy, revalidate)).toMatchObject({ value: 42, outcome: 'MISS' });
    tick(30_000);
    expect(await cache.get('k', loader, policy, revalidate)).toMatchObject({ value: 42, outcome: 'HIT', ageSeconds: 30 });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  test('stale -> served immediately, and only ONE refresh is dispatched (single-flight)', async () => {
    const { cache, revalidate, dispatched, tick } = setup();
    const loader = jest.fn(async () => 1);
    await cache.get('k', loader, policy, revalidate);
    tick(61_000);
    const results = await Promise.all(Array.from({ length: 20 }, () => cache.get('k', loader, policy, revalidate)));
    expect(results.every((r) => r.outcome === 'STALE' && r.value === 1)).toBe(true);
    expect(dispatched).toEqual(['k']);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  test('refresh writes the new value and releases the lock', async () => {
    const { cache, revalidate, dispatched, tick } = setup();
    await cache.get('k', async () => 1, policy, revalidate);
    tick(61_000);
    await cache.get('k', async () => 1, policy, revalidate);
    await cache.refresh('k', async () => 2, policy);
    expect(await cache.get('k', async () => 3, policy, revalidate)).toMatchObject({ value: 2, outcome: 'HIT' });
    tick(61_000);
    await cache.get('k', async () => 3, policy, revalidate);
    expect(dispatched).toHaveLength(2); // lock was released, so a second refresh can start
  });

  test('legacy down + expired entry still present -> STALE_FALLBACK instead of an error', async () => {
    const { cache, revalidate, tick } = setup();
    await cache.get('k', async () => 7, policy, revalidate);
    tick(3_700_000); // past ttl, DynamoDB has not deleted it yet
    const r = await cache.get('k', async () => Promise.reject(new UpstreamUnavailableError('down')), policy, revalidate);
    expect(r).toMatchObject({ value: 7, outcome: 'STALE_FALLBACK' });
  });

  test('legacy down + nothing cached -> the error propagates', async () => {
    const { cache, revalidate } = setup();
    await expect(cache.get('nope', async () => Promise.reject(new UpstreamUnavailableError('down')), policy, revalidate)).rejects.toThrow('down');
  });
});

describe('withIdempotency', () => {
  const body = { holdId: 'HABCDEF1', paymentRef: 'PAY-1' };

  test('replays the stored response for the same key and body', async () => {
    const store = new MemoryKvStore();
    const run = jest.fn(async () => json(202, { jobId: 'j1' }));
    const first = await withIdempotency(store, 'client', 'key-00001', body, run);
    const second = await withIdempotency(store, 'client', 'key-00001', body, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(second.body).toBe(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
  });

  test('rejects the same key with a different body (422)', async () => {
    const store = new MemoryKvStore();
    await withIdempotency(store, 'client', 'key-00001', body, async () => json(202, {}));
    await expect(withIdempotency(store, 'client', 'key-00001', { ...body, paymentRef: 'OTHER' }, async () => json(202, {}))).rejects.toMatchObject({
      status: 422,
    });
  });

  test('a concurrent duplicate gets 409 while the first is in flight', async () => {
    const store = new MemoryKvStore();
    let release!: () => void;
    const slow = withIdempotency(store, 'c', 'key-00002', body, () => new Promise((r) => (release = () => r(json(201, {})))));
    await new Promise((r) => setImmediate(r));
    await expect(withIdempotency(store, 'c', 'key-00002', body, async () => json(201, {}))).rejects.toBeInstanceOf(HttpError);
    release();
    await slow;
  });

  test('business rejections are stored and replayed; upstream failures free the key', async () => {
    const store = new MemoryKvStore();
    const taken = await withIdempotency(store, 'c', 'key-00003', body, async () => Promise.reject(new LegacyFaultError(3001, 'SEAT NOT AVAILABLE')));
    expect(taken.statusCode).toBe(409);
    const replay = await withIdempotency(store, 'c', 'key-00003', body, async () => json(201, {}));
    expect(replay.statusCode).toBe(409);

    await expect(withIdempotency(store, 'c', 'key-00004', body, async () => Promise.reject(new UpstreamUnavailableError('down')))).rejects.toThrow();
    const retry = await withIdempotency(store, 'c', 'key-00004', body, async () => json(201, { ok: true }));
    expect(retry.statusCode).toBe(201);
  });

  test('keys are scoped per client', async () => {
    const store = new MemoryKvStore();
    const run = jest.fn(async () => json(201, {}));
    await withIdempotency(store, 'alice', 'key-00005', body, run);
    await withIdempotency(store, 'bob', 'key-00005', { other: true }, run);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
