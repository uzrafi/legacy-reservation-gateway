// AWS only: per-partner throttling by API Gateway usage plans.
//   phase 1 (60 s): basic and premium keys both send 30 req/s at the same time
//   phase 2 (60 s): premium alone sends 80 req/s (above its 50 req/s limit)
// Expect ~10 req/s accepted for basic (rate 10, burst 20) and all 30 for premium,
// then ~50 req/s accepted for premium in phase 2. Uses one cached fare query.
import http from 'k6/http';
import { Counter } from 'k6/metrics';
import { BASE, isoDate, writeSummary } from './lib.js';

const accepted = new Counter('accepted');
const throttled = new Counter('throttled');
const URL = `${BASE}/fares?origin=YYZ&destination=YUL&date=${isoDate(10)}&fareClass=Y`;
const RATE = Number(__ENV.RATE || 30);

const s = (plan, key, rate, start, phase) => ({
  executor: 'constant-arrival-rate', rate, timeUnit: '1s', duration: '60s', startTime: start,
  preAllocatedVUs: 50, maxVUs: 300, tags: { plan, phase }, env: { KEY: key },
});

export const options = {
  scenarios: {
    basic: s('basic', __ENV.API_KEY_BASIC, RATE, '0s', 'shared'),
    premium: s('premium', __ENV.API_KEY_PREMIUM, RATE, '0s', 'shared'),
    premium_high: s('premium', __ENV.API_KEY_PREMIUM, Number(__ENV.HIGH_RATE || 80), '70s', 'high'),
  },
  thresholds: {
    'accepted{plan:basic,phase:shared}': ['count>=0'],
    'throttled{plan:basic,phase:shared}': ['count>=0'],
    'accepted{plan:premium,phase:shared}': ['count>=0'],
    'throttled{plan:premium,phase:shared}': ['count>=0'],
    'accepted{plan:premium,phase:high}': ['count>=0'],
    'throttled{plan:premium,phase:high}': ['count>=0'],
  },
};

export default function () {
  const res = http.get(URL, { headers: { 'x-api-key': __ENV.KEY, Authorization: `Bearer ${__ENV.TOKEN}` }, tags: { name: 'GET /fares' } });
  if (res.status === 429) throttled.add(1);
  else if (res.status === 200) accepted.add(1);
}

export function handleSummary(data) {
  return writeSummary('throttling', data);
}
