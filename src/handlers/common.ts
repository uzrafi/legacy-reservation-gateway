import type { CacheOutcome } from '../cache/read-through';
import type { BreakerState } from '../resilience/circuit-breaker';

/** Cache/degradation headers shared by the query endpoints. */
export function freshnessHeaders(cache: CacheOutcome, ageSeconds: number, degraded: boolean, circuit: BreakerState): Record<string, string> {
  const h: Record<string, string> = { 'x-cache': cache, 'x-circuit': circuit, 'cache-control': 'private, max-age=30' };
  if (cache !== 'MISS' && cache !== 'BYPASS') h.age = String(ageSeconds);
  if (degraded || cache === 'STALE') h.warning = '110 - "Response is Stale"';
  return h;
}
