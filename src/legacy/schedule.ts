/**
 * Reference data and pricing rules inside the simulated legacy host.
 *
 * This module belongs to the *legacy system*. Nothing in the gateway imports it;
 * the gateway only knows the legacy system through SOAP (see src/adapter).
 * The nightly fare export (export.ts) is the one sanctioned way data leaves it.
 */
import { createHash } from 'node:crypto';

export interface Route {
  orig: string; // 3-letter IATA
  dest: string;
  flight: string; // legacy format, e.g. AC0105
  baseCents: number; // economy base fare
  aircraft: string;
}

const PAIRS: Array<[string, string, number, number, string]> = [
  // orig, dest, flight number (outbound), base fare cents, aircraft
  ['YYZ', 'YVR', 105, 38900, '789'],
  ['YYZ', 'YUL', 403, 15900, '220'],
  ['YYZ', 'YYC', 133, 32900, '32N'],
  ['YYZ', 'YOW', 457, 13900, '220'],
  ['YYZ', 'YHZ', 602, 22900, '32N'],
  ['YUL', 'YVR', 311, 41900, '32N'],
  ['YVR', 'YYC', 215, 14900, '220'],
  ['YYZ', 'LHR', 856, 89900, '789'],
  ['YUL', 'CDG', 870, 84900, '333'],
  ['YVR', 'NRT', 3, 119900, '789'],
  ['YYZ', 'LAX', 791, 45900, '32N'],
  ['YYZ', 'MIA', 1620, 39900, '32N'],
];

export const ROUTES: Route[] = PAIRS.flatMap(([o, d, n, base, ac]) => [
  { orig: o, dest: d, flight: `AC${String(n).padStart(4, '0')}`, baseCents: base, aircraft: ac },
  { orig: d, dest: o, flight: `AC${String(n + 1).padStart(4, '0')}`, baseCents: base, aircraft: ac },
]);

export const FARE_CLASSES = ['Y', 'M', 'O', 'J'] as const;
export type LegacyFareClass = (typeof FARE_CLASSES)[number];

const CLASS_MULTIPLIER: Record<LegacyFareClass, number> = { Y: 1.0, M: 1.35, O: 1.9, J: 3.2 };
const MONTH_FACTOR = [0.9, 0.85, 1.0, 1.0, 1.05, 1.2, 1.3, 1.3, 1.0, 0.95, 0.9, 1.15];

export function findRoute(orig: string, dest: string): Route | undefined {
  return ROUTES.find((r) => r.orig === orig && r.dest === dest);
}

export function findFlight(flight: string): Route | undefined {
  return ROUTES.find((r) => r.flight === flight);
}

/** Deterministic pseudo-random number in [0, 1) derived from a string. */
export function hashUnit(input: string): number {
  const h = createHash('sha1').update(input).digest();
  return h.readUInt32BE(0) / 0x1_0000_0000;
}

/** Base fare after class and seasonal factors, rounded to whole dollars (legacy rule). */
export function baseFareCents(route: Route, date: Date, cls: LegacyFareClass): number {
  const raw = route.baseCents * CLASS_MULTIPLIER[cls] * (MONTH_FACTOR[date.getUTCMonth()] ?? 1);
  return Math.round(raw / 100) * 100;
}

/** Friday and Sunday departures carry a surcharge. */
export function weekendSurchargeCents(date: Date, cls: LegacyFareClass): number {
  const dow = date.getUTCDay();
  if (dow !== 5 && dow !== 0) return 0;
  return cls === 'Y' || cls === 'M' ? 2500 : 4000;
}

/**
 * Intraday re-filing: a small fraction of fares is changed by revenue management
 * during the day, after the nightly export was produced. The modern service can
 * never see these until the next export; they form the irreducible shadow-mismatch floor.
 */
export function intradayAdjustmentCents(route: Route, date: Date, cls: LegacyFareClass, rate: number): number {
  if (rate <= 0) return 0;
  const key = `${route.flight}|${date.toISOString().slice(0, 10)}|${cls}|refile`;
  return hashUnit(key) < rate ? 1500 : 0;
}

export function quoteFareCents(route: Route, date: Date, cls: LegacyFareClass, refileRate: number): number {
  return baseFareCents(route, date, cls) + weekendSurchargeCents(date, cls) + intradayAdjustmentCents(route, date, cls, refileRate);
}

// ---------------------------------------------------------------------------
// Seat maps
// ---------------------------------------------------------------------------

export const SEAT_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
export const ROW_COUNT = 30;
const BUSINESS_ROWS = 4; // rows 1-4 have A, C, D, F only

export function seatExists(row: number, letter: string): boolean {
  if (row < 1 || row > ROW_COUNT) return false;
  if (!SEAT_LETTERS.includes(letter as (typeof SEAT_LETTERS)[number])) return false;
  if (row <= BUSINESS_ROWS && (letter === 'B' || letter === 'E')) return false;
  return true;
}

/** Seats already sold before our simulation started (deterministic per flight/date). */
export function isPreSold(flight: string, dateKey: string, seat: string): boolean {
  return hashUnit(`${flight}|${dateKey}|${seat}|sold`) < 0.55;
}
