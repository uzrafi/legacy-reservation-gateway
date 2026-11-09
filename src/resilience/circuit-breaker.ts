/**
 * Circuit breaker for calls to the legacy host.
 *
 * Local state (rolling window of outcomes) lives in the Lambda instance. That
 * alone is not enough in serverless: each warm instance learns about an outage
 * separately, and every *new* instance starts closed, so a scale-out during an
 * outage would hammer the host with fresh instances. So when any instance trips,
 * it also writes a shared "open until T" flag (DynamoDB). All instances read the
 * flag (cached ~1 s) and back off together. After the cool-down a single probe is
 * allowed through, guarded by a conditional-write lease so that only one
 * instance probes, not one per instance.
 *
 *   closed --(failures >= threshold in window)--> open --(cooldown)--> half-open
 *   half-open --(probe ok)--> closed     half-open --(probe fails)--> open
 */
import { CircuitOpenError } from '../lib/errors';
import type { KvStore } from '../store/kv';

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface SharedBreakerState {
  getOpenUntil(name: string): Promise<number | undefined>;
  setOpenUntil(name: string, until: number): Promise<void>;
  clear(name: string): Promise<void>;
  /** Acquire the half-open probe lease. Returns true for exactly one caller per lease period. */
  tryAcquireProbe(name: string, now: number, leaseMs: number): Promise<boolean>;
}

export class KvSharedBreakerState implements SharedBreakerState {
  constructor(private store: KvStore) {}
  async getOpenUntil(name: string) {
    const it = await this.store.get<{ pk: string; openUntil: number }>(`BREAKER#${name}`);
    return it?.openUntil;
  }
  async setOpenUntil(name: string, until: number) {
    await this.store.put({ pk: `BREAKER#${name}`, openUntil: until, ttl: Math.floor(until / 1000) + 3600 });
  }
  async clear(name: string) {
    await Promise.all([this.store.delete(`BREAKER#${name}`), this.store.delete(`BREAKER#${name}#PROBE`)]);
  }
  async tryAcquireProbe(name: string, now: number, leaseMs: number) {
    return this.store.put(
      { pk: `BREAKER#${name}#PROBE`, leaseUntil: now + leaseMs, ttl: Math.floor((now + leaseMs) / 1000) + 3600 },
      { kind: 'notExistsOrExpired', attr: 'leaseUntil', now },
    );
  }
}

export interface BreakerOptions {
  name: string;
  /** Minimum failures in the window before tripping. */
  failureThreshold: number;
  /** ...and the failure ratio must be at least this. */
  failureRateThreshold: number;
  windowMs: number;
  cooldownMs: number;
  /** How long the shared flag is cached in-process. */
  sharedCacheMs?: number;
  probeLeaseMs?: number;
  shared?: SharedBreakerState;
  now?: () => number;
  onStateChange?: (from: BreakerState, to: BreakerState) => void;
}

export interface Permit {
  state: BreakerState;
  /** True if this call is the half-open probe. */
  probe: boolean;
}

export class CircuitBreaker {
  private outcomes: Array<{ t: number; ok: boolean }> = [];
  private localOpenUntil = 0;
  private sharedOpenUntil = 0;
  private sharedFetchedAt = -Infinity;
  private probeInFlight = false;
  private lastState: BreakerState = 'closed';
  private readonly now: () => number;

  constructor(private readonly opts: BreakerOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** The state as of the last refresh (synchronous; used for headers and metrics). */
  get state(): BreakerState {
    return this.lastState;
  }

  private setState(s: BreakerState) {
    if (s !== this.lastState) {
      const from = this.lastState;
      this.lastState = s;
      this.opts.onStateChange?.(from, s);
    }
  }

  private async refreshShared(now: number) {
    if (!this.opts.shared) return;
    if (now - this.sharedFetchedAt < (this.opts.sharedCacheMs ?? 1000)) return;
    try {
      this.sharedOpenUntil = (await this.opts.shared.getOpenUntil(this.opts.name)) ?? 0;
    } catch {
      // Shared state unavailable: fall back to local state only, never fail the request for it.
    }
    this.sharedFetchedAt = now;
  }

  /** Ask permission to call the legacy host. Throws CircuitOpenError when rejected. */
  async acquire(): Promise<Permit> {
    const now = this.now();
    await this.refreshShared(now);
    const openUntil = Math.max(this.localOpenUntil, this.sharedOpenUntil);

    if (openUntil === 0) {
      this.setState('closed');
      return { state: 'closed', probe: false };
    }
    if (now < openUntil) {
      this.setState('open');
      throw new CircuitOpenError(openUntil - now);
    }
    // Cool-down elapsed: half-open. Exactly one probe at a time.
    this.setState('half-open');
    if (this.probeInFlight) throw new CircuitOpenError(1000);
    if (this.opts.shared && this.sharedOpenUntil > 0) {
      const leased = await this.opts.shared
        .tryAcquireProbe(this.opts.name, now, this.opts.probeLeaseMs ?? 5000)
        .catch(() => true);
      if (!leased) throw new CircuitOpenError(1000);
    }
    this.probeInFlight = true;
    return { state: 'half-open', probe: true };
  }

  async recordSuccess(permit: Permit): Promise<void> {
    const now = this.now();
    if (permit.probe) {
      this.probeInFlight = false;
      this.localOpenUntil = 0;
      this.sharedOpenUntil = 0;
      this.outcomes = [];
      this.setState('closed');
      await this.opts.shared?.clear(this.opts.name).catch(() => undefined);
      return;
    }
    this.push(now, true);
  }

  async recordFailure(permit: Permit): Promise<void> {
    const now = this.now();
    if (permit.probe) {
      this.probeInFlight = false;
      await this.trip(now);
      return;
    }
    this.push(now, false);
    const failures = this.outcomes.filter((o) => !o.ok).length;
    const rate = failures / this.outcomes.length;
    if (failures >= this.opts.failureThreshold && rate >= this.opts.failureRateThreshold && this.localOpenUntil <= now) {
      await this.trip(now);
    }
  }

  /** A call that ended without telling us anything about upstream health (e.g. a 404). */
  release(permit: Permit): void {
    if (permit.probe) this.probeInFlight = false;
  }

  private push(now: number, ok: boolean) {
    this.outcomes.push({ t: now, ok });
    const cutoff = now - this.opts.windowMs;
    while (this.outcomes.length && this.outcomes[0]!.t < cutoff) this.outcomes.shift();
  }

  private async trip(now: number) {
    this.localOpenUntil = now + this.opts.cooldownMs;
    this.outcomes = [];
    this.setState('open');
    if (this.opts.shared) {
      this.sharedOpenUntil = this.localOpenUntil;
      this.sharedFetchedAt = now;
      await this.opts.shared.setOpenUntil(this.opts.name, this.localOpenUntil).catch(() => undefined);
    }
  }
}
