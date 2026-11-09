import { buildFareExportCsv } from '../../src/legacy/export';
import { FARE_CLASSES, quoteFareCents, ROUTES } from '../../src/legacy/schedule';
import { compareQuotes, ModernFareService, parseFareCsv } from '../../src/modern/fare-service';
import { MemoryKvStore } from '../../src/store/kv';

/**
 * Offline version of the shadow comparison: every route x class x day in the
 * export window, legacy price vs modern price. The live shadow run (k6 + metrics)
 * measures the same thing on real traffic; this test pins the expected shape.
 */
async function mismatchRate(rules: 'naive' | 'full', refileRate: number) {
  const start = new Date(Date.UTC(2026, 10, 9));
  const days = 60;
  const store = new MemoryKvStore();
  await store.batchPut(parseFareCsv(buildFareExportCsv(start, days)));
  const modern = new ModernFareService(store, rules);
  let compared = 0;
  let mismatched = 0;
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * 86400_000);
    const date = d.toISOString().slice(0, 10);
    for (const r of ROUTES) {
      for (const cls of FARE_CLASSES) {
        const legacy = {
          quoteId: 'L',
          origin: r.orig,
          destination: r.dest,
          flightNumber: r.flight.replace(/^AC0*/, 'AC'),
          date,
          fareClass: cls,
          priceCents: quoteFareCents(r, d, cls, refileRate),
          currency: 'CAD',
        };
        const m = await modern.quote({ origin: r.orig, destination: r.dest, date, fareClass: cls });
        compared++;
        if (compareQuotes(legacy, m)) mismatched++;
      }
    }
  }
  return mismatched / compared;
}

describe('strangler fig: modern fare service vs legacy pricing', () => {
  test('the naive rules disagree on weekend surcharges and business class', async () => {
    const rate = await mismatchRate('naive', 0);
    // J is 1/4 of classes (always missing); Fri/Sun are ~2/7 of the other 3/4.
    expect(rate).toBeGreaterThan(0.4);
    expect(rate).toBeLessThan(0.5);
  });

  test('the fixed rules match exactly when there is no intraday re-filing', async () => {
    expect(await mismatchRate('full', 0)).toBe(0);
  });

  test('with re-filing, only the irreducible floor remains', async () => {
    const rate = await mismatchRate('full', 0.0005);
    expect(rate).toBeLessThan(0.002);
  });

  test('parseFareCsv normalises flight numbers and keys by feed class', () => {
    const [first] = parseFareCsv('origin,destination,flight,departure_date,fare_class,base_amount_cents,weekend_surcharge_cents,currency\nYYZ,YVR,AC0105,2026-11-13,C,124500,4000,CAD\n');
    expect(first).toMatchObject({ pk: 'YYZ#YVR#2026-11-13#C', flightNumber: 'AC105', baseAmountCents: 124500, weekendSurchargeCents: 4000 });
  });
});
