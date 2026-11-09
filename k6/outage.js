// Legacy outage: after a 2-minute cache warm-up, the host fails 100% of calls for 2 minutes in the middle of the run.
// Measures GET /fares availability before / during / after, and how long after the
// outage ends the first fresh legacy answer arrives (circuit closed again).
import http from 'k6/http';
import { sleep } from 'k6';
import exec from 'k6/execution';
import { Rate, Trend } from 'k6/metrics';
import { fareQuery, fareUrl, header, headers, resetFaults, setFaults, writeSummary } from './lib.js';

const WARMUP = Number(__ENV.WARMUP_S || 120); // warm the cache first, as a live system would be
const OUTAGE_START = WARMUP + Number(__ENV.OUTAGE_START_S || 90);
const OUTAGE_LEN = Number(__ENV.OUTAGE_LEN_S || 120);
const available = new Rate('available');
const stale = new Rate('served_stale');
const recovery = new Trend('circuit_recovered_after_ms');
let recorded = false;

export const options = {
  scenarios: {
    warmup: { executor: 'constant-arrival-rate', rate: 5, timeUnit: '1s', duration: `${WARMUP}s`, preAllocatedVUs: 20, maxVUs: 100 },
    traffic: {
      executor: 'constant-arrival-rate', rate: Number(__ENV.RATE || 10), timeUnit: '1s', duration: __ENV.DURATION || '5m',
      startTime: `${WARMUP}s`, preAllocatedVUs: 40, maxVUs: 200,
    },
    chaos: { executor: 'shared-iterations', iterations: 1, vus: 1, startTime: `${OUTAGE_START}s`, exec: 'chaos', maxDuration: `${OUTAGE_LEN + 60}s` },
  },
  summaryTrendStats: ['min', 'avg', 'p(50)', 'max'],
  thresholds: {
    'available{window:before}': ['rate>=0'],
    'available{window:outage}': ['rate>=0'],
    'available{window:after}': ['rate>=0'],
    'served_stale{window:outage}': ['rate>=0'],
    circuit_recovered_after_ms: ['min>=0'],
  },
};

export function chaos() {
  setFaults({ errorRate: 1 });
  sleep(OUTAGE_LEN);
  resetFaults();
}

export default function () {
  const t = exec.instance.currentTestRunDuration / 1000;
  const window = t < WARMUP ? 'warmup' : t < OUTAGE_START ? 'before' : t < OUTAGE_START + OUTAGE_LEN ? 'outage' : 'after';
  const res = http.get(fareUrl(fareQuery()), { headers: headers(), tags: { name: 'GET /fares', window }, timeout: '30s' });
  available.add(res.status === 200, { window });
  const xc = header(res, 'x-cache');
  stale.add(xc === 'STALE' || xc === 'STALE_FALLBACK', { window });
  // The first fresh legacy answer after the outage means the breaker closed and the host is healthy.
  if (!recorded && window === 'after' && header(res, 'x-circuit') === 'closed' && xc === 'MISS') {
    recovery.add((t - OUTAGE_START - OUTAGE_LEN) * 1000);
    recorded = true;
  }
}

export function handleSummary(data) {
  return writeSummary('outage', data);
}
