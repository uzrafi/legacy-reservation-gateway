/**
 * Operation implementations for the simulated RESLINK/2 host.
 * Every call goes through `hostCall`, which applies the legacy host's bad habits:
 * a global rate limit, slow responses, occasional hangs and injected faults.
 */
import { randomBytes } from 'node:crypto';
import { between, envFaultProfile, type FaultProfile, sleep } from './faults';
import { formatAmount, formatLegacyTimestamp, padCode, parseLegacyDate } from './formats';
import {
  FARE_CLASSES,
  findFlight,
  findRoute,
  isPreSold,
  type LegacyFareClass,
  quoteFareCents,
  ROW_COUNT,
  SEAT_LETTERS,
  seatExists,
} from './schedule';
import type { HoldRecord, LegacyStore } from './store';

export const HOLD_TTL_MS = 15 * 60 * 1000;

export interface LegacyServiceOptions {
  store: LegacyStore;
  credentials: { user: string; password: string };
  now?: () => number;
  random?: () => number;
}

export interface SoapFault {
  Fault: {
    faultcode: string;
    faultstring: string;
    detail: { ResError: { ERRCD: string; ERRTX: string } };
    statusCode: number;
  };
}

export function fault(code: number, text: string): SoapFault {
  return {
    Fault: {
      faultcode: code < 2000 ? 'soap:Client' : 'soap:Server',
      faultstring: `RES-ERR ${code}`,
      detail: { ResError: { ERRCD: String(code), ERRTX: text } },
      statusCode: 500,
    },
  };
}

type Args = Record<string, unknown>;
type Headers = { AuthHeader?: { USR?: string; PWD?: string } } | undefined;

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

export function createLegacyService(opts: LegacyServiceOptions) {
  const { store, credentials } = opts;
  const now = opts.now ?? Date.now;
  const rnd = opts.random ?? Math.random;

  let cachedProfile: { at: number; profile: FaultProfile } | undefined;
  async function profile(): Promise<FaultProfile> {
    const t = now();
    if (cachedProfile && t - cachedProfile.at < 1000) return cachedProfile.profile;
    const override = await store.getFaultProfile().catch(() => undefined);
    const p = { ...envFaultProfile(), ...(override ?? {}) };
    cachedProfile = { at: t, profile: p };
    return p;
  }

  async function hostCall<T>(op: string, headers: Headers, body: (p: FaultProfile) => Promise<T>): Promise<T> {
    const counters: Record<string, number> = { calls_total: 1, [`calls_${op}`]: 1 };
    try {
      const auth = headers?.AuthHeader;
      if (!auth || str(auth.USR) !== credentials.user || str(auth.PWD) !== credentials.password) {
        counters.rejected_auth = 1;
        throw fault(1002, 'SIGN-ON REJECTED');
      }
      const p = await profile();
      if (p.rateLimitPerSec > 0) {
        const hits = await store.hitRateWindow(Math.floor(now() / 1000));
        if (hits > p.rateLimitPerSec) {
          counters.rejected_rate_limit = 1;
          await sleep(between(20, 60, rnd));
          throw fault(9001, 'SYSTEM BUSY - RETRY LATER');
        }
      }
      if (op !== 'IssueTicket') await sleep(between(p.latencyMinMs, p.latencyMaxMs, rnd));
      if (rnd() < p.hangRate) {
        counters.hangs = 1;
        await sleep(p.hangMs);
      }
      if (rnd() < p.errorRate) {
        counters.faults_injected = 1;
        throw fault(9002, 'HOST UNAVAILABLE - CICS REGION DOWN');
      }
      const result = await body(p);
      counters.ok = 1;
      return result;
    } catch (err) {
      if (!(err as SoapFault).Fault) {
        counters.internal_errors = 1;
        throw fault(9003, 'HOST INTERNAL ERROR');
      }
      counters[`fault_${(err as SoapFault).Fault.detail.ResError.ERRCD}`] = 1;
      throw err;
    } finally {
      await store.incrementStats(counters).catch(() => undefined);
    }
  }

  function requireDate(dt: unknown): Date {
    const d = parseLegacyDate(str(dt));
    if (!d) throw fault(1001, 'INVALID FORMAT - DT');
    return d;
  }

  function requireFlight(fltno: unknown) {
    const f = str(fltno);
    if (!/^AC\d{4}$/.test(f)) throw fault(1001, 'INVALID FORMAT - FLTNO');
    const route = findFlight(f);
    if (!route) throw fault(2001, 'FLT NOT FOUND');
    return route;
  }

  /** Seats are 4 characters: zero-padded 3-digit row + letter, e.g. "012A". */
  function requireSeat(seat: unknown): { row: number; letter: string; code: string } {
    const s = str(seat);
    const m = /^(\d{3})([A-F])$/.exec(s);
    if (!m) throw fault(1001, 'INVALID FORMAT - SEAT');
    const row = Number(m[1]);
    if (!seatExists(row, m[2]!)) throw fault(2002, 'SEAT DOES NOT EXIST');
    return { row, letter: m[2]!, code: s };
  }

  async function loadHold(holdId: unknown): Promise<HoldRecord> {
    const id = str(holdId);
    if (!/^H[0-9A-Z]{7}$/.test(id)) throw fault(1001, 'INVALID FORMAT - HOLDID');
    const hold = await store.getHold(id);
    if (!hold) throw fault(3002, 'HOLD NOT FOUND');
    if (hold.status === 'HK' && hold.expiresAt <= now()) {
      hold.status = 'EX';
      await store.saveHold(hold);
      await store.freeSeat(hold.flight, hold.dateKey, hold.seat);
    }
    return hold;
  }

  const ops = {
    async GetFareQuote(args: Args, _cb: unknown, headers: Headers) {
      return hostCall('GetFareQuote', headers, async (p) => {
        const orig = str(args.ORIG);
        const dest = str(args.DEST);
        // Airport codes are 5-character space-padded fields on the wire. node-soap trims them on
        // input, so we validate the 3-letter content; responses are always emitted padded.
        if (!/^[A-Z]{3}$/.test(orig.trim()) || !/^[A-Z]{3}$/.test(dest.trim())) throw fault(1001, 'INVALID FORMAT - ORIG/DEST');
        const date = requireDate(args.DT);
        const cls = str(args.FCLS);
        if (!FARE_CLASSES.includes(cls as LegacyFareClass)) throw fault(1001, 'INVALID FORMAT - FCLS');
        const route = findRoute(orig.trim(), dest.trim());
        if (!route) throw fault(2001, 'NO SVC ON CITY PAIR');
        const cents = quoteFareCents(route, date, cls as LegacyFareClass, p.refileRate);
        return {
          FQ: {
            FQID: `FQ${randomBytes(4).toString('hex').toUpperCase()}`,
            ORIG: padCode(route.orig, 5),
            DEST: padCode(route.dest, 5),
            FLTNO: route.flight,
            DT: str(args.DT),
            FCLS: cls,
            AMT: formatAmount(cents),
            CUR: 'CAD',
          },
        };
      });
    },

    async GetSeatMap(args: Args, _cb: unknown, headers: Headers) {
      return hostCall('GetSeatMap', headers, async () => {
        const route = requireFlight(args.FLTNO);
        requireDate(args.DT);
        const dateKey = str(args.DT);
        const reserved = await store.reservedSeats(route.flight, dateKey, now());
        const rows: string[] = [];
        for (let row = 1; row <= ROW_COUNT; row++) {
          let line = String(row).padStart(3, '0');
          for (const letter of SEAT_LETTERS) {
            const code = `${String(row).padStart(3, '0')}${letter}`;
            if (!seatExists(row, letter)) line += '-';
            else if (reserved.has(code)) line += reserved.get(code);
            else if (isPreSold(route.flight, dateKey, code)) line += 'X';
            else line += 'A';
          }
          rows.push(line);
        }
        return { FLTNO: route.flight, DT: dateKey, ACFT: route.aircraft, ROWS: { ROW: rows } };
      });
    },

    async HoldSeat(args: Args, _cb: unknown, headers: Headers) {
      return hostCall('HoldSeat', headers, async () => {
        const route = requireFlight(args.FLTNO);
        requireDate(args.DT);
        const seat = requireSeat(args.SEAT);
        const pax = str(args.PAXNM);
        if (!/^[A-Z]+\/[A-Z ]+$/.test(pax) || pax.length > 30) throw fault(1001, 'INVALID FORMAT - PAXNM');
        if (isPreSold(route.flight, str(args.DT), seat.code)) throw fault(3001, 'SEAT NOT AVAILABLE');
        const hold: HoldRecord = {
          holdId: `H${randomBytes(5).toString('hex').toUpperCase().slice(0, 7)}`,
          flight: route.flight,
          dateKey: str(args.DT),
          seat: seat.code,
          passenger: pax,
          status: 'HK',
          expiresAt: now() + HOLD_TTL_MS,
        };
        const ok = await store.reserveSeat(hold, now());
        if (!ok) throw fault(3001, 'SEAT NOT AVAILABLE');
        return { HOLDID: hold.holdId, STAT: 'HK', EXPTM: formatLegacyTimestamp(new Date(hold.expiresAt)) };
      });
    },

    async GetHoldStatus(args: Args, _cb: unknown, headers: Headers) {
      return hostCall('GetHoldStatus', headers, async () => {
        const hold = await loadHold(args.HOLDID);
        return {
          HOLDID: hold.holdId,
          STAT: hold.status,
          FLTNO: hold.flight,
          DT: hold.dateKey,
          SEAT: hold.seat,
          EXPTM: formatLegacyTimestamp(new Date(hold.expiresAt)),
          ...(hold.ticketNumber ? { TKTNO: hold.ticketNumber } : {}),
        };
      });
    },

    async ReleaseHold(args: Args, _cb: unknown, headers: Headers) {
      return hostCall('ReleaseHold', headers, async () => {
        const hold = await loadHold(args.HOLDID);
        if (hold.status === 'TK') throw fault(3004, 'HOLD TICKETED - CANNOT RELEASE');
        if (hold.status === 'HK') {
          hold.status = 'XX';
          await store.saveHold(hold);
          await store.freeSeat(hold.flight, hold.dateKey, hold.seat);
        }
        return { HOLDID: hold.holdId, STAT: hold.status };
      });
    },

    async IssueTicket(args: Args, _cb: unknown, headers: Headers) {
      return hostCall('IssueTicket', headers, async (p) => {
        const total = between(p.ticketMinMs, p.ticketMaxMs, rnd);
        await sleep(total * 0.1); // step 1: validate hold
        const hold = await loadHold(args.HOLDID);
        // Idempotent per hold: re-issuing a ticketed hold returns the same ticket.
        if (hold.status === 'TK') return { TKTNO: hold.ticketNumber!, HOLDID: hold.holdId, STAT: 'TK' };
        if (hold.status === 'EX') throw fault(3003, 'HOLD EXPIRED');
        if (hold.status !== 'HK') throw fault(3002, 'HOLD NOT ACTIVE');
        await sleep(total * 0.3); // step 2: build PNR
        const payref = str(args.PAYREF);
        if (!/^[A-Z0-9-]{4,24}$/.test(payref)) throw fault(1001, 'INVALID FORMAT - PAYREF');
        await sleep(total * 0.3); // step 3: authorize form of payment
        if (payref.startsWith('DECLINE')) throw fault(4001, 'FORM OF PAYMENT DECLINED');
        await sleep(total * 0.3); // step 4: issue e-ticket
        hold.status = 'TK';
        hold.ticketNumber = `014${String(Math.floor(rnd() * 1e10)).padStart(10, '0')}`;
        await store.saveHold(hold);
        return { TKTNO: hold.ticketNumber, HOLDID: hold.holdId, STAT: 'TK' };
      });
    },
  };

  return ops;
}

export type LegacyOps = ReturnType<typeof createLegacyService>;
