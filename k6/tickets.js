// Ticketing under injected faults: N jobs of hold -> POST /tickets (202) -> poll until done.
// A share of jobs uses a declined payment so the compensation path runs too.
import http from 'k6/http';
import { sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { BASE, FLIGHT_NUMBERS, headers, isoDate, resetFaults, setFaults, writeSummary } from './lib.js';

const JOBS = Number(__ENV.JOBS || 100);
const DECLINE_RATE = Number(__ENV.DECLINE_RATE || 0.1);

const jobTime = new Trend('job_time_ms');
const success = new Rate('job_success');
const compensated = new Counter('jobs_compensated');
const finished = new Counter('jobs_finished');
const holdFailures = new Counter('hold_failures');

export const options = {
  scenarios: {
    jobs: { executor: 'shared-iterations', iterations: JOBS, vus: Number(__ENV.VUS || 10), maxDuration: '40m' },
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    'job_time_ms{kind:normal}': ['p(95)>=0'],
    'job_success{kind:normal}': ['rate>=0'],
    'job_success{kind:declined}': ['rate>=0'],
    'jobs_compensated{kind:normal}': ['count>=0'],
    'jobs_compensated{kind:declined}': ['count>=0'],
    'jobs_finished{kind:normal}': ['count>=0'],
    hold_failures: ['count>=0'],
  },
};

export function setup() {
  setFaults({ errorRate: Number(__ENV.ERROR_RATE || 0.2) });
}

const key = (p) => `${p}-${__VU}-${__ITER}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
const json = { 'content-type': 'application/json' };

function holdSeat() {
  for (let i = 0; i < 10; i++) {
    const seat = `${5 + Math.floor(Math.random() * 26)}${'ABCDEF'[Math.floor(Math.random() * 6)]}`;
    const body = {
      flightNumber: FLIGHT_NUMBERS[Math.floor(Math.random() * FLIGHT_NUMBERS.length)],
      date: isoDate(7 + Math.floor(Math.random() * 60)),
      seat,
      passenger: { givenName: 'Load', surname: `Tester${__VU}` },
    };
    const res = http.post(`${BASE}/holds`, JSON.stringify(body), {
      headers: headers(Object.assign({ 'Idempotency-Key': key('hold') }, json)),
      tags: { name: 'POST /holds' },
      timeout: '30s',
    });
    if (res.status === 201) return res.json('holdId');
    sleep(res.status === 409 ? 0 : 1); // seat taken: try another; upstream trouble: back off
  }
  return undefined;
}

export default function () {
  const holdId = holdSeat();
  if (!holdId) {
    holdFailures.add(1);
    return;
  }
  const kind = Math.random() < DECLINE_RATE ? 'declined' : 'normal';
  const paymentRef = kind === 'declined' ? `DECLINE-${__VU}${__ITER}` : `PAY-${__VU}-${__ITER}`;
  const started = Date.now();
  const res = http.post(`${BASE}/tickets`, JSON.stringify({ holdId, paymentRef }), {
    headers: headers(Object.assign({ 'Idempotency-Key': key('ticket') }, json)),
    tags: { name: 'POST /tickets' },
  });
  if (res.status !== 202) {
    success.add(false, { kind });
    return;
  }
  const jobId = res.json('jobId');
  for (let i = 0; i < 150; i++) {
    sleep(2);
    const s = http.get(`${BASE}/tickets/${jobId}`, { headers: headers(), tags: { name: 'GET /tickets/{id}' } });
    if (s.status !== 200) continue;
    const status = s.json('status');
    if (status === 'TICKETED' || status === 'FAILED') {
      jobTime.add(Date.now() - started, { kind });
      success.add(status === 'TICKETED', { kind });
      if (s.json('compensated') === true) compensated.add(1, { kind });
      finished.add(1, { kind });
      return;
    }
  }
  success.add(false, { kind }); // never finished within 5 minutes
}

export function teardown() {
  resetFaults();
}

export function handleSummary(data) {
  return writeSummary('tickets', data);
}
