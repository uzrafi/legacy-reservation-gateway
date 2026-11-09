// With the legacy host failing 20% of calls, the client-visible error rate of three arms,
// run one after another at the same request rate:
//   unprotected : no cache, a single attempt (what a naive passthrough would do)
//   no-cache    : timeouts + retries with jitter + circuit breaker
//   full        : the above + read-through cache + stale fallback
import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';
import { fareQuery, fareUrl, headers, resetFaults, setFaults, writeSummary } from './lib.js';

const errors = new Rate('client_errors');
const ARM_SECONDS = Number(__ENV.ARM_SECONDS || 120);
const RATE = Number(__ENV.RATE || 4);

const arm = (name, i) => ({
  executor: 'constant-arrival-rate', rate: RATE, timeUnit: '1s', duration: `${ARM_SECONDS}s`, startTime: `${i * (ARM_SECONDS + 10)}s`,
  preAllocatedVUs: 30, maxVUs: 200, tags: { arm: name }, env: { ARM: name },
});

export const options = {
  scenarios: { unprotected: arm('unprotected', 0), retries_breaker: arm('no-cache', 1), full: arm('full', 2) },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    'client_errors{arm:unprotected}': ['rate>=0'],
    'client_errors{arm:no-cache}': ['rate>=0'],
    'client_errors{arm:full}': ['rate>=0'],
    'http_req_duration{arm:unprotected}': ['p(95)>=0'],
    'http_req_duration{arm:no-cache}': ['p(95)>=0'],
    'http_req_duration{arm:full}': ['p(95)>=0'],
  },
};

export function setup() {
  setFaults({ errorRate: Number(__ENV.ERROR_RATE || 0.2) });
}

export default function () {
  const extra = __ENV.ARM === 'full' ? {} : { 'x-experiment': __ENV.ARM };
  const res = http.get(fareUrl(fareQuery()), { headers: headers(extra), tags: { name: 'GET /fares' }, timeout: '30s' });
  errors.add(res.status >= 500);
  check(res, { '200': (r) => r.status === 200 });
}

export function teardown() {
  resetFaults();
}

export function handleSummary(data) {
  return writeSummary('fault-comparison', data);
}
