import { LegacyClient } from '../../src/adapter/client';
import { buildEnvelope, parseResponse } from '../../src/adapter/xml';
import { CircuitOpenError, LegacyFaultError, UpstreamTimeoutError, UpstreamUnavailableError, ValidationError } from '../../src/lib/errors';
import { CircuitBreaker } from '../../src/resilience/circuit-breaker';
import { fakeFetch, fastPolicy, fixture } from '../helpers';

const creds = async () => ({ user: 'GATEWAY', password: 'pw' });
const client = (fetchImpl: typeof fetch, breaker?: CircuitBreaker) =>
  new LegacyClient({ endpoint: 'http://legacy', credentials: creds, fetchImpl, breaker, policies: { default: fastPolicy } });

const holdReq = { flightNumber: 'AC105', date: '2026-11-13', seat: '12C', passenger: { givenName: 'A', surname: 'B' } };

describe('SOAP envelopes', () => {
  test('requests carry the auth header and escape XML', () => {
    const xml = buildEnvelope('HoldSeat', { PAXNM: 'O<BRIEN/A&B' }, { user: 'GATEWAY', password: 'p&w' });
    expect(xml).toContain('<r:AuthHeader><r:USR>GATEWAY</r:USR><r:PWD>p&amp;w</r:PWD></r:AuthHeader>');
    expect(xml).toContain('<r:HoldSeatRequest><r:PAXNM>O&lt;BRIEN/A&amp;B</r:PAXNM></r:HoldSeatRequest>');
  });

  test('faults are translated, with padded codes trimmed', () => {
    expect(() => parseResponse('HoldSeat', fixture('messy/fault.padded-code.xml'))).toThrow(new LegacyFaultError(3001, 'SEAT NOT AVAILABLE'));
  });

  test('a fault with no ResError detail is treated as an unavailable upstream', () => {
    expect(() => parseResponse('GetFareQuote', fixture('messy/fault.no-detail.xml'))).toThrow(UpstreamUnavailableError);
  });

  test('non-SOAP bodies (proxy error pages, truncation) are unavailable, not crashes', () => {
    expect(() => parseResponse('GetFareQuote', fixture('messy/proxy-502.html'))).toThrow(UpstreamUnavailableError);
    expect(() => parseResponse('GetFareQuote', fixture('messy/truncated.xml'))).toThrow(UpstreamUnavailableError);
  });
});

describe('LegacyClient operations on recorded fixtures', () => {
  test('GetFareQuote maps every quirk to clean JSON', async () => {
    const f = fakeFetch([{ body: fixture('get-fare-quote.ok.xml') }]);
    const { data, meta } = await client(f.fn).getFareQuote({ origin: 'YYZ', destination: 'YVR', date: '2026-11-13', fareClass: 'Y' });
    expect(data).toEqual({
      quoteId: expect.stringMatching(/^FQ/),
      origin: 'YYZ',
      destination: 'YVR',
      flightNumber: 'AC105',
      date: '2026-11-13',
      fareClass: 'Y',
      priceCents: 37500,
      currency: 'CAD',
    });
    expect(meta.attempts).toBe(1);
    expect(f.calls[0]).toContain('<r:ORIG>YYZ  </r:ORIG>');
    expect(f.calls[0]).toContain('<r:DT>13NOV26</r:DT>');
  });

  test('GetFareQuote handles a pretty-printed, CRLF, foreign-prefixed response', async () => {
    const f = fakeFetch([{ body: fixture('messy/get-fare-quote.pretty-crlf-prefixed.xml') }]);
    const { data } = await client(f.fn).getFareQuote({ origin: 'YUL', destination: 'CDG', date: '2027-01-01', fareClass: 'J' });
    expect(data).toMatchObject({ origin: 'YUL', destination: 'CDG', flightNumber: 'AC870', date: '2027-01-01', priceCents: 4900 });
  });

  test('GetSeatMap decodes rows, including a single-row response', async () => {
    const full = await client(fakeFetch([{ body: fixture('get-seat-map.ok.xml') }]).fn).getSeatMap({ flightNumber: 'AC105', date: '2026-11-13' });
    expect(full.data.rows).toHaveLength(30);
    expect(full.data.rows[0]!.seats).toHaveLength(4); // business rows have no B/E
    const one = await client(fakeFetch([{ body: fixture('messy/get-seat-map.single-row.xml') }]).fn).getSeatMap({ flightNumber: 'AC3', date: '2028-02-29' });
    expect(one.data).toMatchObject({ flightNumber: 'AC3', date: '2028-02-29', availableSeats: 2 });
  });

  test('HoldSeat and GetHoldStatus', async () => {
    const hold = await client(fakeFetch([{ body: fixture('hold-seat.ok.xml') }]).fn).holdSeat(holdReq);
    expect(hold.data).toMatchObject({ status: 'held', seat: '12C', expiresAt: expect.stringMatching(/Z$/) });
    const status = await client(fakeFetch([{ body: fixture('get-hold-status.ok.xml') }]).fn).getHoldStatus(hold.data.holdId);
    expect(status.data).toMatchObject({ status: 'held', flightNumber: 'AC105', seat: '12C', date: '2026-11-13' });
  });

  test.each([
    ['get-fare-quote.fault-2001.xml', 2001],
    ['hold-seat.fault-3001.xml', 3001],
    ['issue-ticket.fault-4001.xml', 4001],
  ])('%s raises LegacyFaultError %d and is not retried', async (file, code) => {
    const f = fakeFetch([{ status: 500, body: fixture(file) }]);
    await expect(client(f.fn).getFareQuote({ origin: 'YYZ', destination: 'YVR', date: '2026-11-13' })).rejects.toMatchObject({ code });
    expect(f.calls).toHaveLength(1);
  });

  test('invalid input is rejected before the legacy system sees it', async () => {
    const f = fakeFetch([{ body: '' }]);
    await expect(client(f.fn).getFareQuote({ origin: 'yyz', destination: 'YVR', date: '14/11/2026' })).rejects.toBeInstanceOf(ValidationError);
    expect(f.calls).toHaveLength(0);
  });
});

describe('LegacyClient resilience', () => {
  const ok = { body: fixture('get-fare-quote.ok.xml') };
  const down = { status: 500, body: fixture('get-fare-quote.fault-9002.xml') };
  const q = { origin: 'YYZ', destination: 'YVR', date: '2026-11-13' };

  test('retries retryable faults on idempotent operations', async () => {
    const f = fakeFetch([down, down, ok]);
    expect((await client(f.fn).getFareQuote(q)).meta.attempts).toBe(3);
  });

  test('a hang is cut off by the per-attempt timeout, then retried', async () => {
    const f = fakeFetch(['hang', ok]);
    expect((await client(f.fn).getFareQuote(q)).meta.attempts).toBe(2);
  });

  test('gives up after max attempts with the last error', async () => {
    const f = fakeFetch(['hang']);
    await expect(client(f.fn).getFareQuote(q)).rejects.toBeInstanceOf(UpstreamTimeoutError);
    expect(f.calls).toHaveLength(3);
  });

  test('HoldSeat is not retried after a timeout (it may have succeeded)...', async () => {
    const f = fakeFetch(['hang', { body: fixture('hold-seat.ok.xml') }]);
    await expect(client(f.fn).holdSeat(holdReq)).rejects.toBeInstanceOf(UpstreamTimeoutError);
    expect(f.calls).toHaveLength(1);
  });

  test('...but is retried when the host says it was busy and did nothing (9001)', async () => {
    const busy = { status: 500, body: fixture('get-fare-quote.fault-9002.xml').replace(/9002/g, '9001') };
    const f = fakeFetch([busy, { body: fixture('hold-seat.ok.xml') }]);
    expect((await client(f.fn).holdSeat(holdReq)).meta.attempts).toBe(2);
  });

  test('the breaker opens after repeated failures and stops calling the host', async () => {
    const breaker = new CircuitBreaker({ name: 't', failureThreshold: 3, failureRateThreshold: 0.5, windowMs: 10_000, cooldownMs: 60_000 });
    const f = fakeFetch([down]);
    const c = client(f.fn, breaker);
    await expect(c.getFareQuote(q)).rejects.toBeInstanceOf(LegacyFaultError); // 3 failed attempts trip it
    expect(breaker.state).toBe('open');
    const before = f.calls.length;
    await expect(c.getFareQuote(q)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(f.calls.length).toBe(before);
  });

  test('unprotected mode makes exactly one attempt', async () => {
    const f = fakeFetch([down, ok]);
    await expect(client(f.fn).getFareQuote(q, { resilience: false })).rejects.toBeInstanceOf(LegacyFaultError);
    expect(f.calls).toHaveLength(1);
  });
});
