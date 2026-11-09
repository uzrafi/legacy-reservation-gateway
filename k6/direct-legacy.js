// Baseline: GetFareQuote straight to the legacy SOAP host (no gateway, no cache).
// Kept at 4 req/s so the host's 5 req/s rate limit does not distort the latency.
import http from 'k6/http';
import { check } from 'k6';
import { fareQuery, LEGACY, legacyDate, writeSummary } from './lib.js';

const PASSWORD = __ENV.LEGACY_PASSWORD || 'local-dev-password';

export const options = {
  scenarios: {
    direct: {
      executor: 'constant-arrival-rate', rate: Number(__ENV.RATE || 4), timeUnit: '1s', duration: __ENV.DURATION || '3m',
      preAllocatedVUs: 20, maxVUs: 80,
    },
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
  thresholds: { http_req_duration: ['p(95)>=0'], http_req_failed: ['rate>=0'] },
};

export default function () {
  const q = fareQuery();
  const body =
    '<?xml version="1.0"?><e:Envelope xmlns:e="http://schemas.xmlsoap.org/soap/envelope/" xmlns:r="urn:reslink:v2">' +
    `<e:Header><r:AuthHeader><r:USR>GATEWAY</r:USR><r:PWD>${PASSWORD}</r:PWD></r:AuthHeader></e:Header>` +
    `<e:Body><r:GetFareQuoteRequest><r:ORIG>${q.origin}  </r:ORIG><r:DEST>${q.destination}  </r:DEST>` +
    `<r:DT>${legacyDate(q.date)}</r:DT><r:FCLS>${q.fareClass}</r:FCLS></r:GetFareQuoteRequest></e:Body></e:Envelope>`;
  const res = http.post(`${LEGACY}reslink`, body, {
    headers: { 'content-type': 'text/xml', SOAPAction: '"urn:reslink:v2#GetFareQuote"' },
    timeout: '30s',
  });
  check(res, { 'soap 200': (r) => r.status === 200 });
}

export function handleSummary(data) {
  return writeSummary('direct-legacy', data);
}
