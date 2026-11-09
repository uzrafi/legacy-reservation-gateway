/**
 * AWS entry points for the simulated legacy host.
 *
 * `handler` sits behind a Lambda Function URL. node-soap needs a real http.Server,
 * so on cold start we start one on 127.0.0.1 inside the sandbox and forward each
 * Function URL request to it. The SOAP stack is therefore byte-for-byte the same
 * as the local/Docker version.
 *
 * `exportHandler` is the nightly FAREDUMP job: it writes the fare export CSV to S3.
 */
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { buildFareExportCsv } from './export';
import { startLegacyServer } from './server';
import { DynamoLegacyStore } from './store';

let baseUrl: Promise<string> | undefined;

function ensureServer(): Promise<string> {
  baseUrl ??= startLegacyServer({
    store: new DynamoLegacyStore(process.env.LEGACY_TABLE!),
    credentials: { user: process.env.LEGACY_USER!, password: process.env.LEGACY_PASSWORD! },
    adminToken: process.env.LEGACY_ADMIN_TOKEN!,
    port: 0,
    host: '127.0.0.1',
  }).then((s) => s.url);
  return baseUrl;
}

const FORWARDED = ['content-type', 'soapaction', 'x-admin-token'];

export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const base = await ensureServer();
  const headers: Record<string, string> = {};
  for (const h of FORWARDED) {
    const v = event.headers?.[h];
    if (v) headers[h] = v;
  }
  const method = event.requestContext.http.method;
  const body =
    event.body && method !== 'GET' ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : undefined;
  const qs = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const res = await fetch(`${base}${event.rawPath}${qs}`, { method, headers, body });
  return {
    statusCode: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'text/xml' },
    body: await res.text(),
  };
}

const s3 = new S3Client({});

export async function exportHandler(event: { startDate?: string; days?: number } = {}) {
  const start = event.startDate ? new Date(`${event.startDate}T00:00:00Z`) : new Date();
  const days = event.days ?? Number(process.env.EXPORT_DAYS ?? 120);
  const csv = buildFareExportCsv(start, days);
  const key = `exports/faredump-${new Date().toISOString().slice(0, 10)}.csv`;
  await s3.send(new PutObjectCommand({ Bucket: process.env.EXPORT_BUCKET!, Key: key, Body: csv, ContentType: 'text/csv' }));
  return { bucket: process.env.EXPORT_BUCKET, key, rows: csv.split('\n').length - 2 };
}
