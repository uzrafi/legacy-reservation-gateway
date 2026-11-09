/**
 * Local harness: runs the legacy host and the gateway on this machine, with no AWS.
 *
 *   legacy host : http://127.0.0.1:9081/reslink   (node-soap, fault injection, admin API)
 *   gateway     : http://127.0.0.1:9080           (routes -> the real Lambda handlers)
 *
 * Stand-ins for AWS pieces:
 *   DynamoDB        -> MemoryKvStore with a small artificial latency (LOCAL_DDB_LATENCY_MS, default 5)
 *   Step Functions  -> asl-runner.ts executing infra/sfn/ticketing.asl.json
 *   Self-invoke     -> in-process background promise
 *   Lambda aliases  -> two contexts ("stable" and "canary") with weighted routing
 *   Authorizer      -> all scopes granted, or LOCAL_AUTH=jwt to verify tokens from `npm run token`
 *
 * Harness-only endpoints (never deployed):
 *   GET  /__local/stats     metrics registry + breaker state + legacy host counters
 *   POST /__local/reset     clear metrics, caches and breaker
 *   POST /__local/config    {"stable": {...}, "canary": {...}, "canaryWeight": 0.1}
 */
import './local-env';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { type AppContext, buildContext, setContext } from '../app/context';
import { refreshFare } from '../app/fares';
import { refreshSeatMap } from '../app/seatmaps';
import { runStep, type StepName, type WorkflowInput } from '../app/ticket-worker';
import { handler as authorizer } from '../handlers/authorizer';
import { handler as faresHandler } from '../handlers/fares';
import { handler as holdsHandler } from '../handlers/holds';
import { handler as seatmapsHandler } from '../handlers/seatmaps';
import { handler as ticketsHandler } from '../handlers/tickets';
import { buildFareExportCsv } from '../legacy/export';
import { startLegacyServer } from '../legacy/server';
import { MemoryLegacyStore } from '../legacy/store';
import type { Config } from '../lib/config';
import { localMetricsSnapshot, resetLocalMetrics } from '../lib/observability';
import { ALL_SCOPES, isAllowed } from '../lib/scopes';
import { parseFareCsv } from '../modern/fare-service';
import { MemoryKvStore } from '../store/kv';
import { runStateMachine, type StateMachine } from './asl-runner';

const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? 9080);
const LEGACY_PORT = Number(process.env.LEGACY_PORT ?? 9081);
const DDB_LATENCY = Number(process.env.LOCAL_DDB_LATENCY_MS ?? 5);
const ADMIN_TOKEN = process.env.LEGACY_ADMIN_TOKEN ?? 'local-admin-token';

type Overrides = Partial<Pick<Config, 'fareMode' | 'fareRules' | 'modernVerifySampleRate'>>;

async function main() {
  const legacyStore = new MemoryLegacyStore();
  await startLegacyServer({
    store: legacyStore,
    credentials: { user: 'GATEWAY', password: 'local-dev-password' },
    adminToken: ADMIN_TOKEN,
    port: LEGACY_PORT,
    host: '127.0.0.1',
  });

  // Shared "DynamoDB tables".
  const stateStore = new MemoryKvStore(DDB_LATENCY);
  const faresStore = new MemoryKvStore(DDB_LATENCY);
  let cacheStore = new MemoryKvStore(DDB_LATENCY);

  // Nightly FAREDUMP -> modern fares table (what the S3-triggered loader does on AWS).
  const start = new Date();
  await faresStore.batchPut(parseFareCsv(buildFareExportCsv(start, 120), 'local-faredump.csv'));

  const asl = JSON.parse(readFileSync(path.join(process.cwd(), 'infra/sfn/ticketing.asl.json'), 'utf8')) as StateMachine;
  const started = new Set<string>();

  const make = (overrides: Overrides): AppContext => {
    const self: AppContext = buildContext({
      config: { legacyEndpoint: `http://127.0.0.1:${LEGACY_PORT}/reslink`, ...overrides },
      cacheStore,
      stateStore,
      faresStore,
      revalidate: async (req) => {
        setImmediate(() => {
          const run = req.kind === 'fare' ? refreshFare(self, req.key, req.query) : refreshSeatMap(self, req.key, req.query);
          run.catch(() => undefined);
        });
      },
      workflow: {
        async start(name, input) {
          if (started.has(name)) return; // same semantics as Step Functions execution names
          started.add(name);
          void runStateMachine(asl, input, {
            invoke: async (_resource, payload) => {
              const p = payload as { step: StepName; input: WorkflowInput };
              return runStep(self, p.step, p.input);
            },
          });
        },
      },
    });
    return self;
  };

  let stableOverrides: Overrides = {};
  let canaryOverrides: Overrides | undefined;
  let canaryWeight = 0;
  let stable = make(stableOverrides);
  let canary: AppContext | undefined;

  const pick = (route: string) => (route === 'fares' && canary && Math.random() < canaryWeight ? canary : stable);

  const routes: Array<{
    method: string;
    pattern: RegExp;
    resource: string;
    name: string;
    params: string[];
    fn: (e: APIGatewayProxyEvent) => Promise<unknown>;
  }> = [
    { method: 'GET', pattern: /^\/fares$/, resource: '/fares', name: 'fares', params: [], fn: (e) => faresHandler(e) },
    { method: 'GET', pattern: /^\/seatmaps\/([^/]+)$/, resource: '/seatmaps/{flightNumber}', name: 'seatmaps', params: ['flightNumber'], fn: (e) => seatmapsHandler(e) },
    { method: 'POST', pattern: /^\/holds$/, resource: '/holds', name: 'holds', params: [], fn: (e) => holdsHandler(e) },
    { method: 'POST', pattern: /^\/tickets$/, resource: '/tickets', name: 'tickets', params: [], fn: (e) => ticketsHandler(e) },
    { method: 'GET', pattern: /^\/tickets\/([^/]+)$/, resource: '/tickets/{jobId}', name: 'tickets', params: ['jobId'], fn: (e) => ticketsHandler(e) },
  ];

  const readBody = async (req: http.IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  };
  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const body = await readBody(req);

    if (url.pathname === '/__local/stats') {
      const legacyStats = await legacyStore.getStats();
      return send(res, 200, {
        metrics: localMetricsSnapshot(),
        breaker: stable.breaker.state,
        legacy: legacyStats,
        config: { stable: stableOverrides, canary: canaryOverrides ?? null, canaryWeight },
      });
    }
    if (url.pathname === '/__local/reset' && req.method === 'POST') {
      resetLocalMetrics();
      await legacyStore.resetStats();
      cacheStore = new MemoryKvStore(DDB_LATENCY);
      stable = make(stableOverrides);
      canary = canaryOverrides ? make(canaryOverrides) : undefined;
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/__local/config' && req.method === 'POST') {
      const cfg = JSON.parse(body || '{}') as { stable?: Overrides; canary?: Overrides | null; canaryWeight?: number };
      if (cfg.stable) {
        stableOverrides = cfg.stable;
        stable = make(stableOverrides);
      }
      if (cfg.canary !== undefined) {
        canaryOverrides = cfg.canary ?? undefined;
        canary = canaryOverrides ? make(canaryOverrides) : undefined;
      }
      if (cfg.canaryWeight !== undefined) canaryWeight = cfg.canaryWeight;
      return send(res, 200, { stable: stableOverrides, canary: canaryOverrides ?? null, canaryWeight });
    }

    const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
    if (!route) return send(res, 404, { message: 'Missing Authentication Token' });

    // ---- authorizer
    let principalId = String(req.headers['x-local-principal'] ?? 'local-client');
    let scopes = ALL_SCOPES;
    if (process.env.LOCAL_AUTH === 'jwt') {
      try {
        const policy = await authorizer({
          type: 'REQUEST',
          methodArn: `arn:aws:execute-api:local:000000000000:local/local/${req.method}${url.pathname}`,
          headers: { Authorization: String(req.headers.authorization ?? '') },
        } as never);
        principalId = policy.principalId;
        scopes = String(policy.context?.scopes ?? '').split(' ').filter(Boolean);
      } catch {
        return send(res, 401, { message: 'Unauthorized' });
      }
      if (!isAllowed(req.method!, url.pathname, scopes)) return send(res, 403, { message: 'User is not authorized to access this resource' });
    }

    const m = route.pattern.exec(url.pathname)!;
    const pathParameters = Object.fromEntries(route.params.map((p, i) => [p, decodeURIComponent(m[i + 1]!)]));
    const query = Object.fromEntries(url.searchParams);
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
    const event = {
      httpMethod: req.method,
      path: url.pathname,
      resource: route.resource,
      headers,
      queryStringParameters: Object.keys(query).length ? query : null,
      pathParameters: route.params.length ? pathParameters : null,
      body: body || null,
      isBase64Encoded: false,
      requestContext: { requestId: Math.random().toString(36).slice(2), authorizer: { principalId, scopes: scopes.join(' ') }, identity: {} },
    } as unknown as APIGatewayProxyEvent;

    setContext(pick(route.name));
    try {
      const out = (await route.fn(event)) as { statusCode: number; headers: Record<string, string>; body: string };
      send(res, out.statusCode, out.body, out.headers);
    } catch (err) {
      send(res, 500, { message: (err as Error).message });
    }
  });
  server.keepAliveTimeout = 65_000;
  server.listen(GATEWAY_PORT, '127.0.0.1', () => {
    console.log(`legacy host : http://127.0.0.1:${LEGACY_PORT}/reslink  (WSDL: ?wsdl, admin token: ${ADMIN_TOKEN})`);
    console.log(`gateway     : http://127.0.0.1:${GATEWAY_PORT}  (try /fares?origin=YYZ&destination=YVR&date=${start.toISOString().slice(0, 10)})`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
