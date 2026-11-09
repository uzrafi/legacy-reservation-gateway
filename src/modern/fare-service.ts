/**
 * The modern fare service (strangler fig, v2): quotes fares from DynamoDB,
 * loaded from the legacy host's nightly FAREDUMP export in S3.
 *
 * Two rule sets are kept so the migration write-up can be reproduced:
 *   'naive' - the first version: reads the feed at face value.
 *   'full'  - after fixing what shadow mode revealed:
 *               1. add the weekend_surcharge_cents column (Fri/Sun departures);
 *               2. business class is "C" in the feed but "J" online.
 * See docs/migration.md.
 */
import { randomBytes } from 'node:crypto';
import type { FareClass, FareQuery, FareQuote } from '../domain';
import type { KvItem, KvStore } from '../store/kv';

export type FareRules = 'naive' | 'full';

export interface FareRecord extends KvItem {
  origin: string;
  destination: string;
  flightNumber: string;
  date: string;
  feedClass: string;
  baseAmountCents: number;
  weekendSurchargeCents: number;
  currency: string;
  feedFile?: string;
}

export const fareKey = (origin: string, destination: string, date: string, feedClass: string) =>
  `${origin}#${destination}#${date}#${feedClass}`;

const FEED_CLASS: Record<FareRules, Record<FareClass, string>> = {
  naive: { Y: 'Y', M: 'M', O: 'O', J: 'J' },
  full: { Y: 'Y', M: 'M', O: 'O', J: 'C' },
};

export class ModernFareService {
  constructor(
    private readonly store: KvStore,
    private readonly rules: FareRules,
  ) {}

  /** Returns undefined when the feed has no fare for this query. */
  async quote(q: FareQuery): Promise<FareQuote | undefined> {
    const rec = await this.store.get<FareRecord>(fareKey(q.origin, q.destination, q.date, FEED_CLASS[this.rules][q.fareClass]));
    if (!rec) return undefined;
    const price = this.rules === 'full' ? rec.baseAmountCents + rec.weekendSurchargeCents : rec.baseAmountCents;
    return {
      quoteId: `MQ${randomBytes(4).toString('hex').toUpperCase()}`,
      origin: rec.origin,
      destination: rec.destination,
      flightNumber: rec.flightNumber,
      date: rec.date,
      fareClass: q.fareClass,
      priceCents: price,
      currency: rec.currency,
    };
  }
}

/** Parses one FAREDUMP CSV into fare records (flight numbers normalised to AC105 form). */
export function parseFareCsv(csv: string, feedFile?: string): FareRecord[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines.shift()?.split(',') ?? [];
  const idx = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`FAREDUMP is missing column ${name}`);
    return i;
  };
  const c = {
    origin: idx('origin'),
    destination: idx('destination'),
    flight: idx('flight'),
    date: idx('departure_date'),
    cls: idx('fare_class'),
    base: idx('base_amount_cents'),
    surcharge: idx('weekend_surcharge_cents'),
    currency: idx('currency'),
  };
  return lines.map((line) => {
    const f = line.split(',');
    const flight = f[c.flight]!.trim();
    return {
      pk: fareKey(f[c.origin]!, f[c.destination]!, f[c.date]!, f[c.cls]!),
      origin: f[c.origin]!,
      destination: f[c.destination]!,
      flightNumber: flight.replace(/^([A-Z]{2})0*(\d+)$/, '$1$2'),
      date: f[c.date]!,
      feedClass: f[c.cls]!,
      baseAmountCents: Number(f[c.base]),
      weekendSurchargeCents: Number(f[c.surcharge]),
      currency: f[c.currency]!,
      ...(feedFile ? { feedFile } : {}),
    };
  });
}

export interface ShadowDiff {
  fields: string[];
  legacy: Pick<FareQuote, 'priceCents' | 'currency' | 'flightNumber'>;
  modern?: Pick<FareQuote, 'priceCents' | 'currency' | 'flightNumber'>;
}

/** Compares the business-relevant fields of a legacy and a modern quote. */
export function compareQuotes(legacy: FareQuote, modern: FareQuote | undefined): ShadowDiff | undefined {
  const pick = (q: FareQuote) => ({ priceCents: q.priceCents, currency: q.currency, flightNumber: q.flightNumber });
  if (!modern) return { fields: ['missing'], legacy: pick(legacy) };
  const fields = (['priceCents', 'currency', 'flightNumber'] as const).filter((f) => legacy[f] !== modern[f]);
  return fields.length ? { fields, legacy: pick(legacy), modern: pick(modern) } : undefined;
}
