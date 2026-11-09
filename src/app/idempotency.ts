/**
 * Idempotency-Key handling for POST /holds and POST /tickets.
 *
 *   first request    -> claim IDEM#<client>#<key> (conditional write), run, store response
 *   replay, same body -> stored response, `idempotent-replayed: true`
 *   replay, new body  -> 422 (key reuse with a different request)
 *   concurrent replay -> 409 while the first is still in progress
 *   5xx outcome       -> record deleted, so the client may retry with the same key
 */
import { createHash } from 'node:crypto';
import { HttpError } from '../lib/errors';
import { type HttpResponse, problemResponse } from '../lib/http';
import type { KvStore } from '../store/kv';

const IN_PROGRESS_LEASE_MS = 60_000;
const RETENTION_S = 24 * 3600;

interface IdemRecord {
  pk: string;
  state: 'IN_PROGRESS' | 'COMPLETED';
  requestHash: string;
  lockedUntil?: number;
  response?: { statusCode: number; headers: Record<string, string>; body: string };
  ttl: number;
}

export function requestHash(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export function requireIdempotencyKey(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw new HttpError(400, 'idempotency-key-required', 'Idempotency-Key header required', 'Send an Idempotency-Key header of 8-128 URL-safe characters (a UUID is ideal)');
  }
  return value;
}

export async function withIdempotency(
  store: KvStore,
  scope: string,
  key: string,
  body: unknown,
  run: () => Promise<HttpResponse>,
  now: () => number = Date.now,
): Promise<HttpResponse> {
  const pk = `IDEM#${scope}#${key}`;
  const hash = requestHash(body);
  const t = now();
  const claimed = await store.put(
    { pk, state: 'IN_PROGRESS', requestHash: hash, lockedUntil: t + IN_PROGRESS_LEASE_MS, ttl: Math.floor(t / 1000) + RETENTION_S },
    { kind: 'notExistsOrExpired', attr: 'lockedUntil', now: t },
  );

  if (!claimed) {
    const existing = await store.get<IdemRecord>(pk);
    if (existing && existing.requestHash !== hash) {
      throw new HttpError(422, 'idempotency-key-reused', 'Idempotency-Key reused with a different request');
    }
    if (existing?.state === 'COMPLETED' && existing.response) {
      return { ...existing.response, headers: { ...existing.response.headers, 'idempotent-replayed': 'true' } };
    }
    throw new HttpError(409, 'request-in-progress', 'A request with this Idempotency-Key is still in progress', undefined, {
      retryAfterSeconds: 2,
    });
  }

  let response: HttpResponse;
  try {
    response = await run();
  } catch (err) {
    // Business rejections (4xx, e.g. seat taken) are final and replayable;
    // upstream failures (5xx) release the key so the client can retry.
    const rejected = problemResponse(err);
    if (rejected.statusCode >= 500) {
      await store.delete(pk).catch(() => undefined);
      throw err;
    }
    response = rejected;
  }

  if (response.statusCode >= 500) {
    await store.delete(pk).catch(() => undefined);
    return response;
  }
  await store.put({
    pk,
    state: 'COMPLETED',
    requestHash: hash,
    response: { statusCode: response.statusCode, headers: response.headers, body: String(response.body) },
    ttl: Math.floor(now() / 1000) + RETENTION_S,
  });
  return response;
}
