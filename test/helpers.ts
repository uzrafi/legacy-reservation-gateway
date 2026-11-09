import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { RetryPolicy } from '../src/resilience/retry';

export const fixture = (name: string) => readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

export const fastPolicy: RetryPolicy = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, attemptTimeoutMs: 200, budgetMs: 2000, minAttemptMs: 1 };

type FakeResponse = { status?: number; body: string } | Error | 'hang';

/** A fetch stub that replays queued responses (the last one repeats) and records request bodies. */
export function fakeFetch(responses: FakeResponse[]) {
  const calls: string[] = [];
  const fn = (async (_url: unknown, init?: RequestInit) => {
    calls.push(String(init?.body ?? ''));
    const next = responses.length > 1 ? responses.shift()! : responses[0]!;
    if (next === 'hang') {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
      });
    }
    if (next instanceof Error) throw next;
    return new Response(next.body, { status: next.status ?? 200, headers: { 'content-type': 'text/xml' } });
  }) as typeof fetch;
  return { fn, calls };
}
