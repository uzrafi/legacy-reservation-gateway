// Shared helpers for the k6 experiments. Configure with env vars:
//   BASE_URL            gateway base URL (default: local harness)
//   API_KEY / TOKEN     x-api-key and bearer JWT (AWS)
//   LEGACY_URL          legacy host base URL ending in "/"
//   LEGACY_ADMIN_TOKEN  legacy host admin token (fault injection)
import http from 'k6/http';

export const BASE = (__ENV.BASE_URL || 'http://127.0.0.1:9080').replace(/\/$/, '');
export const LEGACY = __ENV.LEGACY_URL || 'http://127.0.0.1:9081/';
const ADMIN = __ENV.LEGACY_ADMIN_TOKEN || 'local-admin-token';

export function headers(extra) {
  const h = Object.assign({}, extra || {});
  if (__ENV.API_KEY) h['x-api-key'] = __ENV.API_KEY;
  if (__ENV.TOKEN) h.Authorization = `Bearer ${__ENV.TOKEN}`;
  return h;
}

// Same city pairs as the legacy schedule (both directions), most popular first.
const PAIRS = [
  ['YYZ', 'YUL'], ['YYZ', 'YVR'], ['YYZ', 'YOW'], ['YYZ', 'YYC'], ['YVR', 'YYC'], ['YUL', 'YVR'],
  ['YYZ', 'LHR'], ['YYZ', 'YHZ'], ['YYZ', 'LAX'], ['YUL', 'CDG'], ['YYZ', 'MIA'], ['YVR', 'NRT'],
];
export const ROUTES = PAIRS.flatMap(([a, b]) => [[a, b], [b, a]]);
const FLIGHTS = [105, 403, 133, 457, 602, 311, 215, 856, 870, 3, 791, 1620];
export const FLIGHT_NUMBERS = FLIGHTS.flatMap((n) => [`AC${n}`, `AC${n + 1}`]);

// Zipf(s=1.1) popularity over routes: a few trunk routes get most searches.
const ZIPF = (() => {
  const w = ROUTES.map((_, i) => 1 / Math.pow(i + 1, 1.1));
  const total = w.reduce((a, b) => a + b, 0);
  let acc = 0;
  return w.map((x) => (acc += x / total));
})();

function pickRoute() {
  const r = Math.random();
  const i = ZIPF.findIndex((c) => r <= c);
  return ROUTES[i < 0 ? ROUTES.length - 1 : i];
}

export function isoDate(daysAhead) {
  return new Date(Date.now() + daysAhead * 86400000).toISOString().slice(0, 10);
}

// Most searches are for the next two weeks, with a long tail out to 60 days.
function pickDaysAhead() {
  const r = Math.random();
  if (r < 0.6) return 1 + Math.floor(Math.random() * 14);
  if (r < 0.9) return 15 + Math.floor(Math.random() * 16);
  return 31 + Math.floor(Math.random() * 30);
}

function pickClass() {
  const r = Math.random();
  return r < 0.7 ? 'Y' : r < 0.85 ? 'M' : r < 0.93 ? 'O' : 'J';
}

export function fareQuery() {
  const [origin, destination] = pickRoute();
  return { origin, destination, date: isoDate(pickDaysAhead()), fareClass: pickClass() };
}

export function fareUrl(q) {
  return `${BASE}/fares?origin=${q.origin}&destination=${q.destination}&date=${q.date}&fareClass=${q.fareClass}`;
}

export function header(res, name) {
  const lower = name.toLowerCase();
  for (const k of Object.keys(res.headers)) if (k.toLowerCase() === lower) return res.headers[k];
  return undefined;
}

// ---- legacy host admin (fault injection)
export function setFaults(profile) {
  const r = http.post(`${LEGACY}admin/faults`, JSON.stringify(profile), {
    headers: { 'x-admin-token': ADMIN, 'content-type': 'application/json' },
    tags: { name: 'admin' },
  });
  if (r.status !== 200) throw new Error(`setFaults failed: ${r.status} ${r.body}`);
}

export function resetFaults() {
  http.del(`${LEGACY}admin/faults`, null, { headers: { 'x-admin-token': ADMIN }, tags: { name: 'admin' } });
}

// ---- legacy formatting for the direct-to-SOAP baseline
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
export function legacyDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}${MONTHS[Number(m) - 1]}${y.slice(2)}`;
}

export function writeSummary(name, data) {
  const out = {};
  out[`results/raw/${__ENV.RESULT_PREFIX || ''}${name}.json`] = JSON.stringify(data, null, 2);
  out.stdout = `\n${name}: summary written to results/raw/${__ENV.RESULT_PREFIX || ''}${name}.json\n`;
  return out;
}
