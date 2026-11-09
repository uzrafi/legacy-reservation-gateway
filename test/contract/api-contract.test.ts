/**
 * Contract tests: every Lambda handler response must satisfy openapi/openapi.yaml.
 * Handlers run for real against in-memory stores and a fake legacy host replaying
 * recorded SOAP fixtures.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import jestOpenAPI from 'jest-openapi';
import { parse } from 'yaml';
import { buildContext, setContext } from '../../src/app/context';
import { handler as faresHandler } from '../../src/handlers/fares';
import { handler as holds } from '../../src/handlers/holds';
import { handler as seatmapsHandler } from '../../src/handlers/seatmaps';
import { handler as tickets } from '../../src/handlers/tickets';
import type { HttpResponse } from '../../src/lib/http';
import { MemoryKvStore } from '../../src/store/kv';
import { fakeFetch, fixture } from '../helpers';

const spec = parse(readFileSync(path.join(__dirname, '../../openapi/openapi.yaml'), 'utf8'));
jestOpenAPI(spec);

// The query handlers also accept revalidation events; over HTTP they always return a proxy result.
const fares = (e: APIGatewayProxyEvent) => faresHandler(e) as Promise<HttpResponse>;
const seatmaps = (e: APIGatewayProxyEvent) => seatmapsHandler(e) as Promise<HttpResponse>;

/** Adapts a Lambda proxy result into the axios-like shape jest-openapi understands. */
function asAxios(method: string, urlPath: string, res: { statusCode: number; headers?: Record<string, unknown>; body: string }) {
  return {
    status: res.statusCode,
    headers: res.headers ?? {},
    data: res.body ? JSON.parse(res.body) : '',
    request: { method: method.toUpperCase(), path: `/dev${urlPath}` },
  };
}

function event(method: string, resourcePath: string, opts: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: method,
    path: resourcePath,
    headers: {},
    queryStringParameters: null,
    pathParameters: null,
    body: null,
    isBase64Encoded: false,
    requestContext: { requestId: 'r1', authorizer: { principalId: 'partner-a', scopes: 'fares:read holds:write tickets:write' }, identity: {} },
    ...opts,
  } as unknown as APIGatewayProxyEvent;
}

function useLegacy(responses: Parameters<typeof fakeFetch>[0]) {
  const started: string[] = [];
  const ctx = buildContext({
    cacheStore: new MemoryKvStore(),
    stateStore: new MemoryKvStore(),
    faresStore: new MemoryKvStore(),
    fetchImpl: fakeFetch(responses).fn,
    revalidate: async () => undefined,
    workflow: { start: async (name) => void started.push(name) },
    config: { retry: { ...buildContext().config.retry, query: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, attemptTimeoutMs: 200, budgetMs: 500, minAttemptMs: 1 } } },
  });
  setContext(ctx);
  return { ctx, started };
}

const fareQuery = { origin: 'YYZ', destination: 'YVR', date: '2026-11-13' };

describe('GET /fares', () => {
  test('200 matches FareQuote, MISS then HIT', async () => {
    useLegacy([{ body: fixture('get-fare-quote.ok.xml') }]);
    const first = await fares(event('GET', '/fares', { queryStringParameters: fareQuery }));
    expect(asAxios('get', '/fares?origin=YYZ&destination=YVR&date=2026-11-13', first)).toSatisfyApiSpec();
    expect(first.headers?.['x-cache']).toBe('MISS');
    const second = await fares(event('GET', '/fares', { queryStringParameters: fareQuery }));
    expect(second.headers?.['x-cache']).toBe('HIT');
  });

  test('400 problem for invalid parameters', async () => {
    useLegacy([{ body: '' }]);
    const res = await fares(event('GET', '/fares', { queryStringParameters: { origin: 'YYZ', destination: 'YYZ', date: 'tomorrow' } }));
    expect(res.statusCode).toBe(400);
    expect(res.headers?.['content-type']).toBe('application/problem+json');
    expect(asAxios('get', '/fares?origin=YYZ', res)).toSatisfyApiSpec();
  });

  test('404 problem for an unserved route (legacy fault 2001)', async () => {
    useLegacy([{ status: 500, body: fixture('get-fare-quote.fault-2001.xml') }]);
    const res = await fares(event('GET', '/fares', { queryStringParameters: { ...fareQuery, destination: 'ZZZ' } }));
    expect(res.statusCode).toBe(404);
    expect(asAxios('get', '/fares?origin=YYZ', res)).toSatisfyApiSpec();
  });

  test('503 problem with Retry-After when the legacy host is down and nothing is cached', async () => {
    useLegacy([{ status: 500, body: fixture('get-fare-quote.fault-9002.xml') }]);
    const res = await fares(event('GET', '/fares', { queryStringParameters: fareQuery }));
    expect(res.statusCode).toBe(503);
    expect(res.headers?.['retry-after']).toBeDefined();
    expect(asAxios('get', '/fares?origin=YYZ', res)).toSatisfyApiSpec();
  });
});

describe('GET /seatmaps/{flightNumber}', () => {
  test('200 matches SeatMap', async () => {
    useLegacy([{ body: fixture('get-seat-map.ok.xml') }]);
    const res = await seatmaps(event('GET', '/seatmaps/AC105', { pathParameters: { flightNumber: 'AC105' }, queryStringParameters: { date: '2026-11-13' } }));
    expect(res.statusCode).toBe(200);
    expect(asAxios('get', '/seatmaps/AC105?date=2026-11-13', res)).toSatisfyApiSpec();
  });
});

describe('POST /holds', () => {
  const body = JSON.stringify({ flightNumber: 'AC105', date: '2026-11-13', seat: '12C', passenger: { givenName: 'Uzair', surname: 'Rafi' } });

  test('201 matches Hold; replay returns the same hold', async () => {
    useLegacy([{ body: fixture('hold-seat.ok.xml') }]);
    const e = event('POST', '/holds', { body, headers: { 'Idempotency-Key': 'hold-key-0001' } });
    const res = await holds(e);
    expect(res.statusCode).toBe(201);
    expect(asAxios('post', '/holds', res)).toSatisfyApiSpec();
    const replay = await holds(e);
    expect(replay.body).toBe(res.body);
    expect(replay.headers?.['idempotent-replayed']).toBe('true');
  });

  test('409 problem when the seat is taken', async () => {
    useLegacy([{ status: 500, body: fixture('hold-seat.fault-3001.xml') }]);
    const res = await holds(event('POST', '/holds', { body, headers: { 'Idempotency-Key': 'hold-key-0002' } }));
    expect(res.statusCode).toBe(409);
    expect(asAxios('post', '/holds', res)).toSatisfyApiSpec();
  });

  test('400 problem without an Idempotency-Key', async () => {
    useLegacy([{ body: '' }]);
    const res = await holds(event('POST', '/holds', { body }));
    expect(res.statusCode).toBe(400);
    expect(asAxios('post', '/holds', res)).toSatisfyApiSpec();
  });
});

describe('ticketing', () => {
  test('POST /tickets -> 202 TicketJobAccepted; GET /tickets/{id} -> TicketJob; other clients get 404', async () => {
    const { started } = useLegacy([{ body: '' }]);
    const post = await tickets(
      event('POST', '/tickets', { body: JSON.stringify({ holdId: 'HA258845', paymentRef: 'PAY-7731' }), headers: { 'idempotency-key': 'ticket-key-0001' } }),
    );
    expect(post.statusCode).toBe(202);
    expect(asAxios('post', '/tickets', post)).toSatisfyApiSpec();
    const { jobId } = JSON.parse(post.body);
    expect(started).toEqual([jobId]);

    const get = await tickets(event('GET', `/tickets/${jobId}`, { pathParameters: { jobId } }));
    expect(get.statusCode).toBe(200);
    expect(asAxios('get', `/tickets/${jobId}`, get)).toSatisfyApiSpec();

    const other = event('GET', `/tickets/${jobId}`, { pathParameters: { jobId } });
    (other.requestContext.authorizer as Record<string, string>).principalId = 'partner-b';
    const denied = await tickets(other);
    expect(denied.statusCode).toBe(404);
    expect(asAxios('get', `/tickets/${jobId}`, denied)).toSatisfyApiSpec();
  });
});
