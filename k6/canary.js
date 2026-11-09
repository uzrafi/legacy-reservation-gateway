// Steady GET /fares traffic during the strangler-fig canary (10% -> 50% -> 100% to v2).
// Tags every response by which system served it (x-fare-source) and by canary step.
//   AWS:   run alongside `npm run canary -- shift ...` (which moves the Lambda alias weights).
//   Local: LOCAL_CANARY=1 makes this script drive the local harness's weighted routing itself.
import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate } from 'k6/metrics';
import { BASE, fareQuery, fareUrl, header, headers, writeSummary } from './lib.js';

const STEP_SECONDS = Number(__ENV.STEP_SECONDS || 120);
const WARMUP = Number(__ENV.WARMUP_S || 120); // warm the legacy-path cache before the baseline step
const STEPS = [0, 10, 50, 100];
const served = new Counter('served');
const errors = new Rate('errors');

export const options = {
  scenarios: {
    warmup: { executor: 'constant-arrival-rate', rate: 5, timeUnit: '1s', duration: `${WARMUP}s`, preAllocatedVUs: 20, maxVUs: 100, exec: 'warm' },
    traffic: {
      executor: 'constant-arrival-rate', rate: Number(__ENV.RATE || 10), timeUnit: '1s', duration: `${STEP_SECONDS * STEPS.length}s`,
      startTime: `${WARMUP}s`, preAllocatedVUs: 30, maxVUs: 200,
    },
    ...(__ENV.LOCAL_CANARY ? { controller: { executor: 'shared-iterations', iterations: 1, vus: 1, exec: 'controller', startTime: `${WARMUP}s`, maxDuration: `${STEP_SECONDS * STEPS.length + 30}s` } } : {}),
  },
  thresholds: Object.fromEntries(
    STEPS.flatMap((w) => [
      [`errors{step:${w}}`, ['rate>=0']],
      [`served{step:${w},source:legacy}`, ['count>=0']],
      [`served{step:${w},source:modern}`, ['count>=0']],
    ]),
  ),
};

export function controller() {
  for (const w of STEPS) {
    http.post(`${BASE}/__local/config`, JSON.stringify({ canaryWeight: w / 100 }), { headers: { 'content-type': 'application/json' } });
    sleep(STEP_SECONDS);
  }
}

export function warm() {
  http.get(fareUrl(fareQuery()), { headers: headers(), tags: { name: 'warmup' }, timeout: '30s' });
}

export default function () {
  const elapsed = exec.instance.currentTestRunDuration / 1000 - WARMUP;
  const step = STEPS[Math.min(STEPS.length - 1, Math.max(0, Math.floor(elapsed / STEP_SECONDS)))];
  const res = http.get(fareUrl(fareQuery()), { headers: headers(), tags: { name: 'GET /fares', step: String(step) }, timeout: '30s' });
  served.add(1, { step: String(step), source: header(res, 'x-fare-source') || 'none' });
  errors.add(res.status >= 500, { step: String(step) });
  check(res, { '200': (r) => r.status === 200 });
}

export function handleSummary(data) {
  return writeSummary('canary', data);
}
