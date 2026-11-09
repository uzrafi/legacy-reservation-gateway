/**
 * Runs the measurements from the project spec (section 7) and writes the numbers.
 *
 *   npm run experiments -- --target local                 # starts the local harness itself
 *   npm run experiments -- --target aws                   # uses `terraform output` from infra/
 *   npm run experiments -- --target local --only fares,outage
 *
 * Output: results/<target>/<experiment>.json, results/<target>/summary.json and
 * docs/results-<target>.md. Every number in the README's resume bullets comes from here.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type Summary = { metrics: Record<string, { values: Record<string, number> }> };
type Results = Record<string, unknown>;

const target = argValue('target') ?? 'local';
const only = argValue('only')?.split(',');
const outDir = path.join('results', target);
mkdirSync(outDir, { recursive: true });
mkdirSync('results/raw', { recursive: true });

function argValue(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round = (n: number | undefined, d = 1) => (n === undefined || Number.isNaN(n) ? undefined : Math.round(n * 10 ** d) / 10 ** d);

// ------------------------------------------------------------------ target wiring
interface Env {
  BASE_URL: string;
  LEGACY_URL: string;
  LEGACY_ADMIN_TOKEN: string;
  LEGACY_PASSWORD: string;
  API_KEY?: string;
  API_KEY_BASIC?: string;
  API_KEY_PREMIUM?: string;
  TOKEN?: string;
}

let harness: ChildProcess | undefined;
let env: Env;
let aws: { faresFunction: string; alarms: string[] } | undefined;

async function setupLocal(): Promise<Env> {
  log('starting local harness (legacy host :9081, gateway :9080)');
  harness = spawn(process.execPath, [require.resolve('tsx/cli'), 'src/local/run-local.ts'], {
    env: { ...process.env, LOG_LEVEL: 'ERROR' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch('http://127.0.0.1:9080/__local/stats')).ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return {
    BASE_URL: 'http://127.0.0.1:9080',
    LEGACY_URL: 'http://127.0.0.1:9081/',
    LEGACY_ADMIN_TOKEN: 'local-admin-token',
    LEGACY_PASSWORD: 'local-dev-password',
  };
}

async function setupAws(): Promise<Env> {
  const out = JSON.parse(execFileSync('terraform', ['-chdir=infra', 'output', '-json'], { encoding: 'utf8' })) as Record<string, { value: unknown }>;
  const v = <T>(k: string) => out[k]!.value as T;
  const keys = v<Record<string, string>>('api_keys');
  const { issueToken, signingKeyPem } = await import('./issue-token');
  const token = await issueToken({ pem: await signingKeyPem(v<string>('jwt_private_key_param')), sub: 'load-test', scopes: ['fares:read', 'holds:write', 'tickets:write'], ttl: '4h' });
  aws = { faresFunction: v<string>('fares_function_name'), alarms: v<string[]>('canary_alarm_names') };
  return {
    BASE_URL: v<string>('api_base_url'),
    LEGACY_URL: v<string>('legacy_url'),
    LEGACY_ADMIN_TOKEN: v<string>('legacy_admin_token'),
    LEGACY_PASSWORD: v<string>('legacy_password'),
    API_KEY: keys['partner-premium'],
    API_KEY_BASIC: keys['partner-basic'],
    API_KEY_PREMIUM: keys['partner-premium'],
    TOKEN: token,
  };
}

// ------------------------------------------------------------------ helpers
/** fetch with one retry: idle keep-alive sockets can be reset between long k6 runs. */
async function req(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    await sleep(500);
    return fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), connection: 'close' } });
  }
}

async function legacyAdmin(method: string, p: string, body?: unknown) {
  const res = await req(`${env.LEGACY_URL}admin/${p}`, {
    method,
    headers: { 'x-admin-token': env.LEGACY_ADMIN_TOKEN, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json() as Promise<Record<string, number>>;
}

async function local(p: string, body?: unknown) {
  const res = await req(`${env.BASE_URL}/__local/${p}`, {
    method: body === undefined && p === 'stats' ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json() as Promise<{ metrics: { counters: Record<string, number> } }>;
}

async function resetAll() {
  await legacyAdmin('DELETE', 'faults');
  await legacyAdmin('DELETE', 'stats');
  if (target === 'local') await local('reset', {});
}

function k6(script: string, extra: Record<string, string | number> = {}): Summary {
  const name = (extra.NAME as string) ?? script.replace('.js', '');
  const file = path.join('results/raw', `${target}-${name}.json`);
  rmSync(file, { force: true });
  log(`k6 run k6/${script} ${JSON.stringify(extra)}`);
  execFileSync('k6', ['run', '--quiet', `k6/${script}`], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, ...env, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])), RESULT_PREFIX: `${target}-` },
  });
  return JSON.parse(readFileSync(file, 'utf8')) as Summary;
}

const val = (s: Summary, metric: string, stat: string) => s.metrics[metric]?.values[stat];
const count = (s: Summary, metric: string) => val(s, metric, 'count') ?? 0;

function save(name: string, data: Results) {
  writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(data, null, 2));
  log(`${name}: ${JSON.stringify(data)}`);
  return data;
}

// ------------------------------------------------------------------ experiments
const experiments: Record<string, () => Promise<Results>> = {
  async direct() {
    await resetAll();
    const s = k6('direct-legacy.js', { DURATION: '3m', RATE: 4 });
    return save('direct', {
      description: 'GetFareQuote straight to the legacy SOAP host, 4 req/s for 3 min',
      requests: count(s, 'http_reqs'),
      p50_ms: round(val(s, 'http_req_duration', 'p(50)')),
      p95_ms: round(val(s, 'http_req_duration', 'p(95)')),
      p99_ms: round(val(s, 'http_req_duration', 'p(99)')),
      failed_pct: round(100 * (val(s, 'http_req_failed', 'rate') ?? 0), 2),
    });
  },

  async fares() {
    await resetAll();
    const s = k6('fares-mix.js', { WARMUP: '180s', WARM_RATE: 5, DURATION: '5m', RATE: 20 });
    const stats = await legacyAdmin('GET', 'stats');
    const outcomes = ['HIT', 'STALE', 'MISS', 'STALE_FALLBACK', 'BYPASS'].map((o) => [o, count(s, `cache_outcome{phase:measure,outcome:${o}}`)] as const);
    const measured = outcomes.reduce((n, [, c]) => n + c, 0);
    const hits = outcomes.filter(([o]) => o !== 'MISS' && o !== 'BYPASS').reduce((n, [, c]) => n + c, 0);
    const served = count(s, 'http_reqs');
    const legacyCalls = stats.calls_GetFareQuote ?? 0;
    return save('fares', {
      description: 'GET /fares via the gateway, realistic mix: 3 min cache warm-up at 5 req/s, then 5 min at 20 req/s (measured)',
      measured_requests: measured,
      p50_ms: round(val(s, 'http_req_duration{phase:measure}', 'p(50)')),
      p95_ms: round(val(s, 'http_req_duration{phase:measure}', 'p(95)')),
      p99_ms: round(val(s, 'http_req_duration{phase:measure}', 'p(99)')),
      failed_pct: round(100 * (val(s, 'http_req_failed{phase:measure}', 'rate') ?? 0), 2),
      cache_hit_rate_pct: round((100 * hits) / measured),
      outcomes: Object.fromEntries(outcomes),
      requests_served_total: served,
      legacy_fare_calls_total: legacyCalls,
      legacy_calls_avoided_pct: round(100 * (1 - legacyCalls / served)),
    });
  },

  async faults() {
    await resetAll();
    const s = k6('fault-comparison.js', { ARM_SECONDS: 120, RATE: 4, ERROR_RATE: 0.2 });
    const arm = (a: string) => ({
      client_error_pct: round(100 * (val(s, `client_errors{arm:${a}}`, 'rate') ?? 0), 2),
      p95_ms: round(val(s, `http_req_duration{arm:${a}}`, 'p(95)')),
    });
    const stats = await legacyAdmin('GET', 'stats');
    return save('faults', {
      description: 'Legacy host failing 20% of calls (plus 1% 10 s hangs); 4 req/s for 2 min per arm',
      unprotected: arm('unprotected'),
      retries_and_breaker: arm('no-cache'),
      full_protection: arm('full'),
      legacy_calls: stats.calls_GetFareQuote,
      legacy_faults_injected: stats.faults_injected,
    });
  },

  async outage() {
    await resetAll();
    const s = k6('outage.js', { WARMUP_S: 120, OUTAGE_START_S: 90, OUTAGE_LEN_S: 120, DURATION: '5m', RATE: 10 });
    return save('outage', {
      description: 'After a 2 min cache warm-up, the legacy host fails 100% of calls for 2 min in the middle of a 5 min, 10 req/s run',
      availability_before_pct: round(100 * (val(s, 'available{window:before}', 'rate') ?? 0), 2),
      availability_during_outage_pct: round(100 * (val(s, 'available{window:outage}', 'rate') ?? 0), 2),
      availability_after_pct: round(100 * (val(s, 'available{window:after}', 'rate') ?? 0), 2),
      served_stale_during_outage_pct: round(100 * (val(s, 'served_stale{window:outage}', 'rate') ?? 0), 2),
      circuit_recovery_s: round((val(s, 'circuit_recovered_after_ms', 'min') ?? NaN) / 1000),
    });
  },

  async tickets() {
    await resetAll();
    const jobs = Number(argValue('jobs') ?? 100);
    const s = k6('tickets.js', { JOBS: jobs, VUS: 10, ERROR_RATE: 0.2, DECLINE_RATE: 0.1 });
    const stats = await legacyAdmin('GET', 'stats');
    return save('tickets', {
      description: `${jobs} ticketing jobs with the legacy host failing 20% of calls; ~10% use a declined payment`,
      jobs_finished_normal: count(s, 'jobs_finished{kind:normal}'),
      success_pct_normal: round(100 * (val(s, 'job_success{kind:normal}', 'rate') ?? 0), 2),
      p50_job_s: round((val(s, 'job_time_ms{kind:normal}', 'p(50)') ?? NaN) / 1000),
      p95_job_s: round((val(s, 'job_time_ms{kind:normal}', 'p(95)') ?? NaN) / 1000),
      declined_jobs: Math.round((val(s, 'job_success{kind:declined}', 'passes') ?? 0) + (val(s, 'job_success{kind:declined}', 'fails') ?? 0)),
      compensations_declined: count(s, 'jobs_compensated{kind:declined}'),
      compensations_normal: count(s, 'jobs_compensated{kind:normal}'),
      hold_failures: count(s, 'hold_failures'),
      legacy_faults_injected: stats.faults_injected,
      legacy_issue_ticket_calls: stats.calls_IssueTicket,
    });
  },

  async shadow() {
    const out: Results = { description: 'Shadow mode: serve legacy, compare with the modern fare service. 60 s warm-up + 3 min at 10 req/s per rule set' };
    for (const rules of ['naive', 'full'] as const) {
      await resetAll();
      let version: string | undefined;
      const started = new Date();
      if (target === 'local') {
        await local('config', { stable: { fareMode: 'shadow', fareRules: rules }, canary: null, canaryWeight: 0 });
      } else {
        const { prepareVersion, shiftTraffic } = await import('./canary');
        version = await prepareVersion(aws!.faresFunction, { FARE_MODE: 'shadow', MODERN_FARE_RULES: rules }, `shadow ${rules}`);
        await shiftTraffic(aws!.faresFunction, version, [100], 5, []);
      }
      k6('fares-mix.js', { NAME: `shadow-${rules}`, WARMUP: '60s', WARM_RATE: 5, DURATION: '3m', RATE: 10 });
      const { compared, mismatched, fields } = target === 'local' ? await localShadowCounts() : await awsShadowCounts(started);
      out[rules] = { compared, mismatched, mismatch_pct: round((100 * mismatched) / compared, 3), by_field: fields };
    }
    if (target === 'local') await local('config', { stable: {}, canary: null, canaryWeight: 0 });
    return save('shadow', out);
  },

  async canary() {
    await resetAll();
    const step = 120;
    let rolledBack = false;
    if (target === 'local') {
      await local('config', { stable: { fareMode: 'legacy' }, canary: { fareMode: 'modern', fareRules: 'full' }, canaryWeight: 0 });
      k6('canary.js', { STEP_SECONDS: step, WARMUP_S: 120, RATE: 10, LOCAL_CANARY: 1 });
      await local('config', { stable: {}, canary: null, canaryWeight: 0 });
    } else {
      const { prepareVersion, shiftTraffic } = await import('./canary');
      const v = await prepareVersion(aws!.faresFunction, { FARE_MODE: 'modern', MODERN_FARE_RULES: 'full' }, 'modern full');
      const shift = (async () => {
        await sleep((120 + step) * 1000); // k6 warms the cache for 120 s, then runs the 0% baseline step
        rolledBack = !(await shiftTraffic(aws!.faresFunction, v, [10, 50, 100], step, aws!.alarms));
      })();
      k6('canary.js', { STEP_SECONDS: step, WARMUP_S: 120, RATE: 10 });
      await shift;
    }
    const s = JSON.parse(readFileSync(path.join('results/raw', `${target}-canary.json`), 'utf8')) as Summary;
    const steps = [0, 10, 50, 100].map((w) => {
      const legacy = count(s, `served{step:${w},source:legacy}`);
      const modern = count(s, `served{step:${w},source:modern}`);
      return {
        step_pct: w,
        requests: legacy + modern,
        modern_share_pct: round((100 * modern) / Math.max(1, legacy + modern)),
        error_pct: round(100 * (val(s, `errors{step:${w}}`, 'rate') ?? 0), 3),
      };
    });
    return save('canary', { description: `Canary 0 -> 10 -> 50 -> 100% to the modern fare service, ${step} s per step, 10 req/s`, rolled_back: rolledBack, steps });
  },

  async throttling() {
    if (target !== 'aws') return save('throttling', { skipped: 'usage plans exist only on API Gateway' });
    const s = k6('throttling.js', { RATE: 30, HIGH_RATE: 80 });
    const r = (plan: string, phase: string) => ({
      accepted_per_s: round(count(s, `accepted{plan:${plan},phase:${phase}}`) / 60),
      throttled_per_s: round(count(s, `throttled{plan:${plan},phase:${phase}}`) / 60),
    });
    return save('throttling', {
      description: 'basic (10 req/s, burst 20) and premium (50 req/s, burst 100) keys at 30 req/s each for 60 s, then premium at 80 req/s',
      basic_at_30rps: r('basic', 'shared'),
      premium_at_30rps: r('premium', 'shared'),
      premium_at_80rps: r('premium', 'high'),
    });
  },
};

async function localShadowCounts() {
  const c = (await local('stats')).metrics.counters;
  const fields = Object.fromEntries(
    Object.entries(c)
      .filter(([k]) => k.startsWith('FareShadowMismatchField'))
      .map(([k, v]) => [k.replace(/^.*field=([^}]+)}$/, '$1'), v]),
  );
  return { compared: c.FareShadowCompared ?? 0, mismatched: c.FareShadowMismatch ?? 0, fields };
}

async function awsShadowCounts(start: Date) {
  const { CloudWatchClient, GetMetricDataCommand } = await import('@aws-sdk/client-cloudwatch');
  await sleep(90_000); // let EMF metrics land
  const cw = new CloudWatchClient({});
  const q = (id: string, name: string, dims: Record<string, string> = {}) => ({
    Id: id,
    MetricStat: {
      Metric: { Namespace: 'ReservationGateway', MetricName: name, Dimensions: Object.entries({ service: 'reservation-gateway', ...dims }).map(([Name, Value]) => ({ Name, Value })) },
      Period: 60,
      Stat: 'Sum',
    },
  });
  const res = await cw.send(
    new GetMetricDataCommand({
      StartTime: start,
      EndTime: new Date(),
      MetricDataQueries: [q('c', 'FareShadowCompared'), q('m', 'FareShadowMismatch'), q('p', 'FareShadowMismatchField', { field: 'priceCents' }), q('x', 'FareShadowMismatchField', { field: 'missing' })],
    }),
  );
  const sum = (id: string) => (res.MetricDataResults?.find((r) => r.Id === id)?.Values ?? []).reduce((a, b) => a + b, 0);
  return { compared: sum('c'), mismatched: sum('m'), fields: { priceCents: sum('p'), missing: sum('x') } };
}

// ------------------------------------------------------------------ report
function report(all: Record<string, Results>) {
  const lines = [`# Measured results (${target})`, '', `Generated by \`npm run experiments -- --target ${target}\` on ${new Date().toISOString()}.`, ''];
  for (const [name, r] of Object.entries(all)) {
    lines.push(`## ${name}`, '', String(r.description ?? ''), '', '```json', JSON.stringify(r, null, 2), '```', '');
  }
  const file = path.join('docs', `results-${target}.md`);
  writeFileSync(file, lines.join('\n'));
  log(`wrote ${file}`);
}

async function main() {
  env = target === 'local' ? await setupLocal() : await setupAws();
  const summaryFile = path.join(outDir, 'summary.json');
  const all: Record<string, Results> = existsSync(summaryFile) ? JSON.parse(readFileSync(summaryFile, 'utf8')) : {};
  try {
    for (const [name, run] of Object.entries(experiments)) {
      if (only && !only.includes(name)) continue;
      all[name] = await run();
      writeFileSync(summaryFile, JSON.stringify(all, null, 2));
    }
  } finally {
    await legacyAdmin('DELETE', 'faults').catch(() => undefined);
    harness?.kill();
  }
  report(all);
}

main().catch((err) => {
  console.error(err);
  harness?.kill();
  process.exit(1);
});
