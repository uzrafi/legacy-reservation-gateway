/**
 * GET /fares in three modes (FARE_MODE), which is how the strangler fig works:
 *   legacy - v1: read-through cache in front of the legacy host.
 *   shadow - v2 in shadow: serve the legacy answer, also ask the modern service,
 *            compare, log and count mismatches.
 *   modern - v2 live: serve the modern answer (fall back to legacy if the feed has
 *            no fare), and keep verifying a sample against legacy.
 */
import type { CacheOutcome } from '../cache/read-through';
import { type FareQuery, fareQuerySchema, type FareQuote } from '../domain';
import { validate } from '../lib/validate';
import { countMetric, logger, traced } from '../lib/observability';
import { compareQuotes } from '../modern/fare-service';
import type { AppContext } from './context';

export interface ExperimentFlags {
  cache: boolean;
  resilience: boolean;
}
export const DEFAULT_FLAGS: ExperimentFlags = { cache: true, resilience: true };

export function experimentFlags(value: string | undefined, allowed: boolean): ExperimentFlags {
  if (!allowed || !value) return DEFAULT_FLAGS;
  if (value === 'unprotected') return { cache: false, resilience: false };
  if (value === 'no-cache') return { cache: false, resilience: true };
  if (value === 'no-resilience') return { cache: true, resilience: false };
  return DEFAULT_FLAGS;
}

export interface FareResult {
  quote: FareQuote;
  source: 'legacy' | 'modern';
  cache: CacheOutcome;
  ageSeconds: number;
  degraded: boolean;
}

export const fareCacheKey = (q: FareQuery) => `FARE#${q.origin}#${q.destination}#${q.date}#${q.fareClass}`;

export function parseFareQuery(raw: unknown): FareQuery {
  return validate(fareQuerySchema, raw ?? {}, '(query)');
}

async function legacyFare(ctx: AppContext, q: FareQuery, flags: ExperimentFlags): Promise<FareResult> {
  const loader = async () => (await ctx.legacy.getFareQuote(q, { resilience: flags.resilience })).data;
  if (!flags.cache) {
    return { quote: await loader(), source: 'legacy', cache: 'BYPASS', ageSeconds: 0, degraded: false };
  }
  const key = fareCacheKey(q);
  const r = await traced('cache.fares', () =>
    ctx.cache.get(key, loader, ctx.config.farePolicy, (k) => ctx.revalidate({ kind: 'fare', key: k, query: { ...q } })),
  );
  countMetric('CacheLookups', 1, { cache: 'fares', outcome: r.outcome });
  return { quote: r.value, source: 'legacy', cache: r.outcome, ageSeconds: r.ageSeconds, degraded: r.outcome === 'STALE_FALLBACK' };
}

function recordComparison(q: FareQuery, legacy: FareQuote, modern: FareQuote | undefined, phase: 'shadow' | 'verify') {
  const diff = compareQuotes(legacy, modern);
  countMetric('FareShadowCompared', 1);
  if (!diff) return;
  countMetric('FareShadowMismatch', 1);
  for (const f of diff.fields) countMetric('FareShadowMismatchField', 1, { field: f });
  logger.warn('fare_shadow_mismatch', { phase, query: q, ...diff });
}

export async function getFare(ctx: AppContext, rawQuery: unknown, flags: ExperimentFlags = DEFAULT_FLAGS): Promise<FareResult> {
  const q = parseFareQuery(rawQuery);
  const mode = ctx.config.fareMode;

  if (mode === 'legacy') return legacyFare(ctx, q, flags);

  if (mode === 'shadow') {
    const [legacy, modern] = await Promise.allSettled([
      legacyFare(ctx, q, flags),
      traced('modern.quote', () => ctx.modernFares.quote(q)),
    ]);
    if (legacy.status === 'rejected') throw legacy.reason;
    if (modern.status === 'fulfilled') recordComparison(q, legacy.value.quote, modern.value, 'shadow');
    else logger.warn('shadow modern lookup failed', { error: (modern.reason as Error).message });
    return legacy.value;
  }

  // modern
  const modern = await traced('modern.quote', () => ctx.modernFares.quote(q));
  if (!modern) {
    countMetric('ModernFallbackToLegacy', 1);
    return legacyFare(ctx, q, flags);
  }
  if (Math.random() < ctx.config.modernVerifySampleRate) {
    try {
      const legacy = await legacyFare(ctx, q, flags);
      recordComparison(q, legacy.quote, modern, 'verify');
    } catch (err) {
      logger.info('verification sample skipped', { error: (err as Error).message });
    }
  }
  return { quote: modern, source: 'modern', cache: 'BYPASS', ageSeconds: 0, degraded: false };
}

/** Body of a background revalidation (async self-invoke on Lambda). */
export async function refreshFare(ctx: AppContext, key: string, query: Record<string, string>) {
  const q = parseFareQuery(query);
  await ctx.cache.refresh(key, async () => (await ctx.legacy.getFareQuote(q)).data, ctx.config.farePolicy);
}
