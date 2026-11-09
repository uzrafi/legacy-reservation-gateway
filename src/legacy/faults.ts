/**
 * Fault injection for the simulated legacy host.
 *
 * Defaults come from environment variables; a runtime override can be set through
 * the admin endpoint (POST /admin/faults) so experiments can flip the host into an
 * outage without redeploying. The override lives in the legacy store, so every
 * Lambda instance of the legacy host sees it within ~1 s.
 */
export interface FaultProfile {
  latencyMinMs: number;
  latencyMaxMs: number;
  /** Probability that a call fails with a retryable host fault (9002). */
  errorRate: number;
  /** Probability that a call hangs for hangMs before answering. */
  hangRate: number;
  hangMs: number;
  /** Requests per second the host accepts across all callers; beyond that: fault 9001. 0 = unlimited. */
  rateLimitPerSec: number;
  /** IssueTicket is slow and multi-step. */
  ticketMinMs: number;
  ticketMaxMs: number;
  /** Fraction of fares re-filed intraday (not in the nightly export). */
  refileRate: number;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function envFaultProfile(): FaultProfile {
  return {
    latencyMinMs: num('LEGACY_LATENCY_MIN_MS', 600),
    latencyMaxMs: num('LEGACY_LATENCY_MAX_MS', 1500),
    errorRate: num('LEGACY_ERROR_RATE', 0),
    hangRate: num('LEGACY_HANG_RATE', 0.01),
    hangMs: num('LEGACY_HANG_MS', 10000),
    rateLimitPerSec: num('LEGACY_RATE_LIMIT_RPS', 5),
    ticketMinMs: num('LEGACY_TICKET_MIN_MS', 5000),
    ticketMaxMs: num('LEGACY_TICKET_MAX_MS', 20000),
    refileRate: num('LEGACY_REFILE_RATE', 0.0005),
  };
}

const NUMERIC_KEYS: Array<keyof FaultProfile> = [
  'latencyMinMs',
  'latencyMaxMs',
  'errorRate',
  'hangRate',
  'hangMs',
  'rateLimitPerSec',
  'ticketMinMs',
  'ticketMaxMs',
  'refileRate',
];

/** Validates an override coming from the admin endpoint. */
export function parseFaultOverride(input: unknown): Partial<FaultProfile> {
  if (typeof input !== 'object' || input === null) throw new Error('fault profile must be an object');
  const out: Partial<FaultProfile> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!NUMERIC_KEYS.includes(k as keyof FaultProfile)) throw new Error(`unknown fault setting: ${k}`);
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`${k} must be a non-negative number`);
    if ((k === 'errorRate' || k === 'hangRate' || k === 'refileRate') && v > 1) throw new Error(`${k} must be <= 1`);
    out[k as keyof FaultProfile] = v;
  }
  return out;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function between(min: number, max: number, rnd: () => number = Math.random): number {
  return min + (max - min) * rnd();
}
