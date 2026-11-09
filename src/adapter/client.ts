/**
 * Anti-corruption layer, part 3: the typed client the rest of the gateway uses.
 * Nothing outside src/adapter knows that SOAP, XML or RESLINK codes exist.
 *
 * Each call: validate input (zod) -> map to legacy values -> build envelope ->
 * [breaker permit -> HTTP POST with hard timeout] x retries -> parse -> map back.
 */
import {
  fareQuerySchema,
  type FareQuote,
  type Hold,
  type HoldRequest,
  holdRequestSchema,
  type IssuedTicket,
  type SeatMap,
  seatMapQuerySchema,
  ticketRequestSchema,
} from '../domain';
import {
  CircuitOpenError,
  isRetryableUpstreamError,
  isUpstreamHealthFailure,
  LegacyFaultError,
  UpstreamTimeoutError,
  UpstreamUnavailableError,
} from '../lib/errors';
import { validate } from '../lib/validate';
import { countMetric, traced } from '../lib/observability';
import type { CircuitBreaker } from '../resilience/circuit-breaker';
import { LegacyBusyError, type WindowRateLimiter } from '../resilience/rate-limiter';
import { retryWithBudget, type RetryPolicy } from '../resilience/retry';
import {
  decodeSeatRow,
  fromLegacyAirport,
  fromLegacyAmount,
  fromLegacyDate,
  fromLegacyFlight,
  fromLegacyHoldStatus,
  fromLegacySeat,
  fromLegacyTimestamp,
  toLegacyAirport,
  toLegacyDate,
  toLegacyFlight,
  toLegacyPassengerName,
  toLegacySeat,
} from './codes';
import { buildEnvelope, parseResponse, RESLINK_NS, text } from './xml';

export type Operation = 'GetFareQuote' | 'GetSeatMap' | 'HoldSeat' | 'GetHoldStatus' | 'ReleaseHold' | 'IssueTicket';

/**
 * Retry safety per operation:
 *  - 'idempotent': reads, and writes the host deduplicates (IssueTicket per hold,
 *    ReleaseHold) - retry any retryable fault or timeout.
 *  - 'rejected-only': HoldSeat is NOT idempotent; after a timeout we cannot know
 *    whether the seat was held. Retry only when the host says it did nothing (9001).
 */
const RETRY_SAFETY: Record<Operation, 'idempotent' | 'rejected-only'> = {
  GetFareQuote: 'idempotent',
  GetSeatMap: 'idempotent',
  GetHoldStatus: 'idempotent',
  HoldSeat: 'rejected-only',
  ReleaseHold: 'idempotent',
  IssueTicket: 'idempotent',
};

export interface LegacyClientOptions {
  endpoint: string;
  credentials: () => Promise<{ user: string; password: string }>;
  breaker?: CircuitBreaker;
  /** Fleet-wide admission control so the gateway never exceeds the host's rate limit. */
  limiter?: WindowRateLimiter;
  /** Retry policy per operation (falls back to `default`). */
  policies: Partial<Record<Operation, RetryPolicy>> & { default: RetryPolicy };
  fetchImpl?: typeof fetch;
  /** Set false to disable retries + breaker (the "unprotected" experiment arm). */
  resilience?: boolean;
}

export interface CallMeta {
  attempts: number;
}

export interface CallOptions {
  /** Override resilience for this call (experiments). */
  resilience?: boolean;
}

export class LegacyClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: LegacyClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get breakerState() {
    return this.opts.breaker?.state ?? 'closed';
  }

  private async once(op: Operation, envelope: string, timeoutMs: number, protectedCall: boolean, deadline: number): Promise<Record<string, unknown>> {
    const breaker = protectedCall ? this.opts.breaker : undefined;
    let permit: Awaited<ReturnType<CircuitBreaker['acquire']>> | undefined;
    try {
      permit = breaker ? await breaker.acquire() : undefined;
    } catch (err) {
      countMetric('CircuitOpenRejections', 1); // alarm: breaker open for 5+ minutes
      throw err;
    }
    if (protectedCall && this.opts.limiter) {
      try {
        // Leave at least ~1.5 s of the budget for the call itself.
        await this.opts.limiter.acquire(deadline - 1500);
      } catch (err) {
        if (permit) breaker!.release(permit);
        countMetric('LegacyCallsShed', 1);
        throw err;
      }
      timeoutMs = Math.min(timeoutMs, Math.max(250, deadline - Date.now()));
    }
    countMetric('LegacyCalls', 1, { operation: op });
    const started = Date.now();
    try {
      const result = await traced(`legacy.${op}`, async () => {
        let res: Response;
        try {
          res = await this.fetchImpl(this.opts.endpoint, {
            method: 'POST',
            headers: { 'content-type': 'text/xml; charset=utf-8', SOAPAction: `"${RESLINK_NS}#${op}"` },
            body: envelope,
            signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
          });
        } catch (err) {
          const name = (err as Error).name;
          if (name === 'TimeoutError' || name === 'AbortError') throw new UpstreamTimeoutError(`${op} exceeded ${timeoutMs} ms`);
          throw new UpstreamUnavailableError(`${op}: ${(err as Error).message}`);
        }
        let body: string;
        try {
          body = await res.text();
        } catch (err) {
          const name = (err as Error).name;
          if (name === 'TimeoutError' || name === 'AbortError') throw new UpstreamTimeoutError(`${op} exceeded ${timeoutMs} ms`);
          throw new UpstreamUnavailableError(`${op}: ${(err as Error).message}`);
        }
        // SOAP 1.1 faults arrive as HTTP 500 with a Fault body; anything else non-2xx is a transport problem.
        if (!res.ok && !body.includes('Fault')) throw new UpstreamUnavailableError(`${op}: HTTP ${res.status}`);
        return parseResponse(op, body);
      }, { operation: op });
      if (permit) await breaker!.recordSuccess(permit);
      return result;
    } catch (err) {
      if (err instanceof LegacyFaultError) countMetric('LegacyFaults', 1, { code: String(err.code) });
      if (err instanceof UpstreamTimeoutError) countMetric('LegacyTimeouts', 1);
      if (permit) {
        if (isUpstreamHealthFailure(err)) await breaker!.recordFailure(permit);
        else if (err instanceof LegacyFaultError && err.code !== 9001) await breaker!.recordSuccess(permit); // host answered sanely
        else breaker!.release(permit);
      }
      throw err;
    } finally {
      countMetric('LegacyLatencyMs', Date.now() - started, { operation: op }, 'Milliseconds');
    }
  }

  private async call(op: Operation, body: Record<string, string>, options: CallOptions = {}): Promise<{ node: Record<string, unknown>; meta: CallMeta }> {
    const envelope = buildEnvelope(op, body, await this.opts.credentials());
    const policy = this.opts.policies[op] ?? this.opts.policies.default;
    const resilient = options.resilience ?? this.opts.resilience ?? true;

    if (!resilient) {
      const node = await this.once(op, envelope, policy.attemptTimeoutMs, false, Date.now() + policy.attemptTimeoutMs);
      return { node, meta: { attempts: 1 } };
    }

    const safety = RETRY_SAFETY[op];
    const deadline = Date.now() + policy.budgetMs;
    const outcome = await retryWithBudget(
      (_attempt, timeoutMs) => this.once(op, envelope, timeoutMs, true, deadline),
      policy,
      (err) => {
        if (err instanceof CircuitOpenError || err instanceof LegacyBusyError) return false;
        if (safety === 'rejected-only') return err instanceof LegacyFaultError && err.rejectedBeforeProcessing;
        return isRetryableUpstreamError(err);
      },
    );
    if (outcome.attempts > 1) countMetric('LegacyRetries', outcome.attempts - 1, { operation: op });
    return { node: outcome.value, meta: { attempts: outcome.attempts } };
  }

  // ---------------------------------------------------------------- operations

  async getFareQuote(input: unknown, options?: CallOptions): Promise<{ data: FareQuote; meta: CallMeta }> {
    const q = validate(fareQuerySchema, input);
    const { node, meta } = await this.call(
      'GetFareQuote',
      { ORIG: toLegacyAirport(q.origin), DEST: toLegacyAirport(q.destination), DT: toLegacyDate(q.date), FCLS: q.fareClass },
      options,
    );
    const fq = (node.FQ ?? {}) as Record<string, unknown>;
    return {
      data: {
        quoteId: text(fq, 'FQID').trim(),
        origin: fromLegacyAirport(text(fq, 'ORIG')),
        destination: fromLegacyAirport(text(fq, 'DEST')),
        flightNumber: fromLegacyFlight(text(fq, 'FLTNO')),
        date: fromLegacyDate(text(fq, 'DT')),
        fareClass: text(fq, 'FCLS').trim() as FareQuote['fareClass'],
        priceCents: fromLegacyAmount(text(fq, 'AMT')),
        currency: text(fq, 'CUR').trim(),
      },
      meta,
    };
  }

  async getSeatMap(input: unknown, options?: CallOptions): Promise<{ data: SeatMap; meta: CallMeta }> {
    const q = validate(seatMapQuerySchema, input);
    const { node, meta } = await this.call('GetSeatMap', { FLTNO: toLegacyFlight(q.flightNumber), DT: toLegacyDate(q.date) }, options);
    const rowsNode = (node.ROWS ?? {}) as Record<string, unknown>;
    const rawRows = (rowsNode.ROW ?? []) as unknown[];
    const rows = rawRows.map((r) => decodeSeatRow(typeof r === 'string' ? r : String((r as Record<string, unknown>)['#text'] ?? '')));
    return {
      data: {
        flightNumber: fromLegacyFlight(text(node, 'FLTNO')),
        date: fromLegacyDate(text(node, 'DT')),
        aircraft: text(node, 'ACFT').trim(),
        availableSeats: rows.reduce((n, r) => n + r.seats.filter((s) => s.status === 'available').length, 0),
        rows,
      },
      meta,
    };
  }

  async holdSeat(input: unknown, options?: CallOptions): Promise<{ data: Hold; meta: CallMeta }> {
    const h: HoldRequest = validate(holdRequestSchema, input);
    const { node, meta } = await this.call(
      'HoldSeat',
      {
        FLTNO: toLegacyFlight(h.flightNumber),
        DT: toLegacyDate(h.date),
        SEAT: toLegacySeat(h.seat),
        PAXNM: toLegacyPassengerName(h.passenger.givenName, h.passenger.surname),
      },
      options,
    );
    return {
      data: {
        holdId: text(node, 'HOLDID').trim(),
        status: fromLegacyHoldStatus(text(node, 'STAT')),
        expiresAt: fromLegacyTimestamp(text(node, 'EXPTM')),
        flightNumber: h.flightNumber,
        date: h.date,
        seat: h.seat,
      },
      meta,
    };
  }

  async getHoldStatus(holdId: string, options?: CallOptions): Promise<{ data: Hold; meta: CallMeta }> {
    const { holdId: id } = validate(ticketRequestSchema.pick({ holdId: true }), { holdId });
    const { node, meta } = await this.call('GetHoldStatus', { HOLDID: id }, options);
    const tkt = text(node, 'TKTNO').trim();
    return {
      data: {
        holdId: text(node, 'HOLDID').trim(),
        status: fromLegacyHoldStatus(text(node, 'STAT')),
        expiresAt: fromLegacyTimestamp(text(node, 'EXPTM')),
        flightNumber: fromLegacyFlight(text(node, 'FLTNO')),
        date: fromLegacyDate(text(node, 'DT')),
        seat: fromLegacySeat(text(node, 'SEAT')),
        ...(tkt ? { ticketNumber: tkt } : {}),
      },
      meta,
    };
  }

  async releaseHold(holdId: string, options?: CallOptions): Promise<{ data: { holdId: string; status: Hold['status'] }; meta: CallMeta }> {
    const { holdId: id } = validate(ticketRequestSchema.pick({ holdId: true }), { holdId });
    const { node, meta } = await this.call('ReleaseHold', { HOLDID: id }, options);
    return { data: { holdId: text(node, 'HOLDID').trim(), status: fromLegacyHoldStatus(text(node, 'STAT')) }, meta };
  }

  async issueTicket(input: unknown, options?: CallOptions): Promise<{ data: IssuedTicket; meta: CallMeta }> {
    const t = validate(ticketRequestSchema, input);
    const { node, meta } = await this.call('IssueTicket', { HOLDID: t.holdId, PAYREF: t.paymentRef.toUpperCase() }, options);
    return { data: { ticketNumber: text(node, 'TKTNO').trim(), holdId: text(node, 'HOLDID').trim() }, meta };
  }
}
