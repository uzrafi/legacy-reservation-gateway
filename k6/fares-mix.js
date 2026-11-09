// GET /fares through the gateway with a realistic route/date/class mix:
// a 1-minute warm-up at a low rate, then the measured phase.
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { fareQuery, fareUrl, header, headers, writeSummary } from './lib.js';

const cache = new Counter('cache_outcome');
const NAME = __ENV.NAME || 'fares-mix';
const WARMUP = __ENV.WARMUP || '60s';

export const options = {
  scenarios: {
    warmup: {
      executor: 'constant-arrival-rate', rate: Number(__ENV.WARM_RATE || 4), timeUnit: '1s', duration: WARMUP,
      preAllocatedVUs: 20, maxVUs: 100, tags: { phase: 'warmup' },
    },
    measure: {
      executor: 'constant-arrival-rate', rate: Number(__ENV.RATE || 20), timeUnit: '1s', duration: __ENV.DURATION || '4m',
      startTime: WARMUP, preAllocatedVUs: 50, maxVUs: 300, tags: { phase: 'measure' },
    },
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    'http_req_duration{phase:measure}': ['p(95)>=0'],
    'http_req_failed{phase:measure}': ['rate>=0'],
    'cache_outcome{phase:measure,outcome:HIT}': ['count>=0'],
    'cache_outcome{phase:measure,outcome:STALE}': ['count>=0'],
    'cache_outcome{phase:measure,outcome:MISS}': ['count>=0'],
    'cache_outcome{phase:measure,outcome:STALE_FALLBACK}': ['count>=0'],
    'cache_outcome{phase:measure,outcome:BYPASS}': ['count>=0'],
  },
};

export default function () {
  const extra = __ENV.EXPERIMENT ? { 'x-experiment': __ENV.EXPERIMENT } : {};
  const res = http.get(fareUrl(fareQuery()), { headers: headers(extra), tags: { name: 'GET /fares' }, timeout: '30s' });
  cache.add(1, { outcome: header(res, 'x-cache') || 'NONE' });
  check(res, { '200': (r) => r.status === 200 });
}

export function handleSummary(data) {
  return writeSummary(NAME, data);
}
