/**
 * DynamoDB read-through cache with stale-while-revalidate.
 *
 * Each entry has two clocks:
 *   freshUntil (ms) - until then, serve it as a plain hit;
 *   ttl (epoch s)   - DynamoDB TTL deletes it after this (for free).
 * Between the two, the entry is *stale but servable*: we return it immediately
 * and trigger one background refresh. A conditional write on LOCK#<key> makes
 * the refresh single-flight, so a traffic spike on a stale key produces exactly
 * one legacy call, not one per request.
 *
 * If the legacy host fails on a miss and an entry exists (even past `ttl`,
 * because DynamoDB deletes lazily), we serve it as a degraded STALE_FALLBACK.
 */
import { logger } from '../lib/observability';
import type { KvStore } from '../store/kv';

export interface CachePolicy {
  /** How long a value is fresh. */
  freshMs: number;
  /** How long a value is kept at all (DynamoDB TTL). */
  ttlSeconds: number;
  /** Refresh lock lease. */
  lockMs?: number;
}

export type CacheOutcome = 'HIT' | 'STALE' | 'MISS' | 'STALE_FALLBACK' | 'BYPASS';

export interface CacheResult<T> {
  value: T;
  outcome: CacheOutcome;
  /** Seconds since the value was fetched from the source. */
  ageSeconds: number;
  /** Error that forced a STALE_FALLBACK. */
  degradedBy?: unknown;
}

interface Entry<T> {
  pk: string;
  value: T;
  fetchedAt: number;
  freshUntil: number;
  ttl: number;
}

/**
 * Starts a refresh of `key` "in the background". On Lambda this is an async
 * self-invocation (the sandbox freezes after we return, so an in-process promise
 * would not finish); locally it is an un-awaited promise.
 */
export type RevalidateDispatcher = (key: string) => Promise<void>;

export class ReadThroughCache {
  constructor(
    private readonly store: KvStore,
    private readonly now: () => number = Date.now,
  ) {}

  async read<T>(key: string): Promise<Entry<T> | undefined> {
    try {
      return await this.store.get<Entry<T>>(key);
    } catch (err) {
      logger.warn('cache read failed; treating as miss', { key, error: (err as Error).message });
      return undefined;
    }
  }

  async write<T>(key: string, value: T, policy: CachePolicy): Promise<void> {
    const now = this.now();
    try {
      await this.store.put({ pk: key, value, fetchedAt: now, freshUntil: now + policy.freshMs, ttl: Math.floor(now / 1000) + policy.ttlSeconds });
    } catch (err) {
      logger.warn('cache write failed', { key, error: (err as Error).message });
    }
  }

  async tryLock(key: string, policy: CachePolicy): Promise<boolean> {
    const now = this.now();
    const leaseMs = policy.lockMs ?? 10_000;
    try {
      return await this.store.put(
        { pk: `LOCK#${key}`, lockUntil: now + leaseMs, ttl: Math.floor((now + leaseMs) / 1000) + 60 },
        { kind: 'notExistsOrExpired', attr: 'lockUntil', now },
      );
    } catch {
      return false;
    }
  }

  async unlock(key: string): Promise<void> {
    await this.store.delete(`LOCK#${key}`).catch(() => undefined);
  }

  /** Refresh one key from the source (the body of a background revalidation). */
  async refresh<T>(key: string, loader: () => Promise<T>, policy: CachePolicy): Promise<void> {
    try {
      const value = await loader();
      await this.write(key, value, policy);
    } finally {
      await this.unlock(key);
    }
  }

  async get<T>(
    key: string,
    loader: () => Promise<T>,
    policy: CachePolicy,
    revalidate: RevalidateDispatcher,
  ): Promise<CacheResult<T>> {
    const now = this.now();
    const entry = await this.read<T>(key);
    const age = (e: Entry<T>) => Math.max(0, Math.floor((now - e.fetchedAt) / 1000));

    if (entry && now < entry.freshUntil) return { value: entry.value, outcome: 'HIT', ageSeconds: age(entry) };

    if (entry && now < entry.ttl * 1000) {
      if (await this.tryLock(key, policy)) {
        await revalidate(key).catch(async (err) => {
          logger.warn('revalidation dispatch failed', { key, error: (err as Error).message });
          await this.unlock(key);
        });
      }
      return { value: entry.value, outcome: 'STALE', ageSeconds: age(entry) };
    }

    try {
      const value = await loader();
      await this.write(key, value, policy);
      return { value, outcome: 'MISS', ageSeconds: 0 };
    } catch (err) {
      if (entry) return { value: entry.value, outcome: 'STALE_FALLBACK', ageSeconds: age(entry), degradedBy: err };
      throw err;
    }
  }
}
