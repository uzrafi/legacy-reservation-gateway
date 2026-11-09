import type { CacheOutcome } from '../cache/read-through';
import { type SeatMap, type SeatMapQuery, seatMapQuerySchema } from '../domain';
import { validate } from '../lib/validate';
import { countMetric, traced } from '../lib/observability';
import type { AppContext } from './context';
import { DEFAULT_FLAGS, type ExperimentFlags } from './fares';

export const seatMapCacheKey = (q: SeatMapQuery) => `SEATMAP#${q.flightNumber}#${q.date}`;

export function parseSeatMapQuery(raw: unknown): SeatMapQuery {
  return validate(seatMapQuerySchema, raw ?? {}, '(query)');
}

export async function getSeatMap(
  ctx: AppContext,
  raw: unknown,
  flags: ExperimentFlags = DEFAULT_FLAGS,
): Promise<{ seatMap: SeatMap; cache: CacheOutcome; ageSeconds: number; degraded: boolean }> {
  const q = parseSeatMapQuery(raw);
  const loader = async () => (await ctx.legacy.getSeatMap(q, { resilience: flags.resilience })).data;
  if (!flags.cache) return { seatMap: await loader(), cache: 'BYPASS', ageSeconds: 0, degraded: false };
  const key = seatMapCacheKey(q);
  const r = await traced('cache.seatmaps', () =>
    ctx.cache.get(key, loader, ctx.config.seatMapPolicy, (k) => ctx.revalidate({ kind: 'seatmap', key: k, query: { ...q } })),
  );
  countMetric('CacheLookups', 1, { cache: 'seatmaps', outcome: r.outcome });
  return { seatMap: r.value, cache: r.outcome, ageSeconds: r.ageSeconds, degraded: r.outcome === 'STALE_FALLBACK' };
}

export async function refreshSeatMap(ctx: AppContext, key: string, query: Record<string, string>) {
  const q = parseSeatMapQuery(query);
  await ctx.cache.refresh(key, async () => (await ctx.legacy.getSeatMap(q)).data, ctx.config.seatMapPolicy);
}

/** A hold changes the seat map: drop the cached copy so the next read is fresh. */
export async function invalidateSeatMap(ctx: AppContext, q: SeatMapQuery) {
  await ctx.cacheStore.delete(seatMapCacheKey(q)).catch(() => undefined);
}
