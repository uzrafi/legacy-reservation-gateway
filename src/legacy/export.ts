/**
 * The legacy host's nightly fare export ("FAREDUMP"), the data feed the modern
 * fare service is built from. Like most real feeds it does not look exactly like
 * the online system:
 *   - the weekend surcharge is a separate column, not folded into the amount;
 *   - business class is filed as "C" in the feed but quoted as "J" online;
 *   - intraday re-filings never appear (they happen after the dump).
 * Discovering these through shadow comparison is the point of docs/migration.md.
 */
import { baseFareCents, FARE_CLASSES, type LegacyFareClass, ROUTES, weekendSurchargeCents } from './schedule';

export const CSV_HEADER = 'origin,destination,flight,departure_date,fare_class,base_amount_cents,weekend_surcharge_cents,currency';

const FEED_CLASS_CODE: Record<LegacyFareClass, string> = { Y: 'Y', M: 'M', O: 'O', J: 'C' };

export function* fareExportRows(startDate: Date, days: number): Generator<string> {
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate() + i));
    const iso = d.toISOString().slice(0, 10);
    for (const route of ROUTES) {
      for (const cls of FARE_CLASSES) {
        yield [
          route.orig,
          route.dest,
          route.flight,
          iso,
          FEED_CLASS_CODE[cls],
          baseFareCents(route, d, cls),
          weekendSurchargeCents(d, cls),
          'CAD',
        ].join(',');
      }
    }
  }
}

export function buildFareExportCsv(startDate: Date, days: number): string {
  return [CSV_HEADER, ...fareExportRows(startDate, days)].join('\n') + '\n';
}
