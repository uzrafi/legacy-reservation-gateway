import type { CachePolicy } from '../cache/read-through';
import type { FareRules } from '../modern/fare-service';
import type { RetryPolicy } from '../resilience/retry';

const num = (name: string, fallback: number) => {
  const v = process.env[name];
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const policy = (p: RetryPolicy): RetryPolicy => p;

export type FareMode = 'legacy' | 'shadow' | 'modern';

export function loadConfig() {
  return {
    legacyEndpoint: process.env.LEGACY_ENDPOINT ?? 'http://127.0.0.1:9081/reslink',
    /** SSM SecureString holding {"user": "...", "password": "..."}. */
    legacyCredentialsParam: process.env.LEGACY_CREDENTIALS_PARAM,
    cacheTable: process.env.CACHE_TABLE,
    stateTable: process.env.STATE_TABLE,
    faresTable: process.env.FARES_TABLE,
    stateMachineArn: process.env.STATE_MACHINE_ARN,

    fareMode: (process.env.FARE_MODE ?? 'legacy') as FareMode,
    fareRules: (process.env.MODERN_FARE_RULES ?? 'full') as FareRules,
    /** In 'modern' mode, the share of requests also checked against legacy. */
    modernVerifySampleRate: num('MODERN_VERIFY_SAMPLE_RATE', 0.1),
    /** Lets k6 select experiment arms with `x-experiment`. Demo stages only. */
    allowExperimentHeaders: process.env.ALLOW_EXPERIMENT_HEADERS === 'true',

    farePolicy: { freshMs: num('FARE_FRESH_MS', 5 * 60_000), ttlSeconds: num('FARE_TTL_S', 24 * 3600) } satisfies CachePolicy,
    // Seat maps change with every hold, so they go stale much faster than fares.
    seatMapPolicy: { freshMs: num('SEATMAP_FRESH_MS', 15_000), ttlSeconds: num('SEATMAP_TTL_S', 300) } satisfies CachePolicy,

    /** Fleet-wide calls/s to the legacy host (its own limit is 5). 0 disables. */
    legacyRateLimitPerSec: num('LEGACY_CALLS_PER_SEC', 5),

    breaker: {
      failureThreshold: num('BREAKER_FAILURE_THRESHOLD', 5),
      failureRateThreshold: num('BREAKER_FAILURE_RATE', 0.5),
      windowMs: num('BREAKER_WINDOW_MS', 10_000),
      cooldownMs: num('BREAKER_COOLDOWN_MS', 15_000),
    },

    retry: {
      // Queries: 2 s hard timeout per attempt, 3 attempts, all inside a 5 s budget
      // (the Lambda timeout is 8 s; API Gateway's is 29 s).
      query: policy({
        maxAttempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 800,
        attemptTimeoutMs: num('QUERY_TIMEOUT_MS', 2000),
        budgetMs: num('QUERY_BUDGET_MS', 5000),
      }),
      // HoldSeat is retried only on "busy, did nothing" faults (see RETRY_SAFETY).
      command: policy({ maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 1000, attemptTimeoutMs: 3000, budgetMs: 6000 }),
      // Ticketing steps: Step Functions owns the retries, so one attempt each.
      workflow: policy({ maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, attemptTimeoutMs: num('TICKET_TIMEOUT_MS', 28_000), budgetMs: 30_000 }),
    },
  };
}

export type Config = ReturnType<typeof loadConfig>;
