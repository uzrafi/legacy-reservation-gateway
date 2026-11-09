/**
 * POST /holds (synchronous, idempotent) and the asynchronous ticketing API:
 *   POST /tickets       -> 202 + jobId, starts a Step Functions Standard execution
 *   GET  /tickets/{id}  -> job status from DynamoDB
 */
import { createHash } from 'node:crypto';
import { holdRequestSchema, type TicketJob, ticketRequestSchema } from '../domain';
import { HttpError } from '../lib/errors';
import { validate } from '../lib/validate';
import { type HttpResponse, json } from '../lib/http';
import type { KvStore } from '../store/kv';
import type { AppContext } from './context';
import { withIdempotency } from './idempotency';
import { invalidateSeatMap } from './seatmaps';

export async function createHold(ctx: AppContext, principal: string, idemKey: string, body: unknown): Promise<HttpResponse> {
  const req = validate(holdRequestSchema, body);
  return withIdempotency(ctx.stateStore, principal, idemKey, req, async () => {
    const { data } = await ctx.legacy.holdSeat(req);
    await invalidateSeatMap(ctx, { flightNumber: req.flightNumber, date: req.date });
    return json(201, data, { location: `/holds/${data.holdId}` });
  });
}

// ------------------------------------------------------------------ jobs

export interface JobItem extends TicketJob {
  pk: string;
  owner: string;
  ttl: number;
}

export const jobPk = (jobId: string) => `JOB#${jobId}`;

/** Deterministic job id: the same client + Idempotency-Key always maps to the same execution name. */
export function jobIdFor(principal: string, idemKey: string): string {
  const h = createHash('sha256').update(`${principal}\n${idemKey}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function publicJob(item: JobItem): TicketJob {
  const { pk: _pk, owner: _owner, ttl: _ttl, ...job } = item;
  return job;
}

export async function updateJob(store: KvStore, jobId: string, patch: Partial<TicketJob>): Promise<JobItem> {
  const existing = await store.get<JobItem>(jobPk(jobId));
  if (!existing) throw new Error(`job ${jobId} not found`);
  const next: JobItem = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  await store.put(next);
  return next;
}

export async function startTicketJob(ctx: AppContext, principal: string, idemKey: string, body: unknown): Promise<HttpResponse> {
  const req = validate(ticketRequestSchema, body);
  return withIdempotency(ctx.stateStore, principal, idemKey, req, async () => {
    const jobId = jobIdFor(principal, idemKey);
    const now = new Date().toISOString();
    const item: JobItem = {
      pk: jobPk(jobId),
      jobId,
      owner: principal,
      status: 'PENDING',
      holdId: req.holdId,
      createdAt: now,
      updatedAt: now,
      ttl: Math.floor(Date.now() / 1000) + 30 * 86400,
    };
    await ctx.stateStore.put(item, { kind: 'notExists' });
    await ctx.workflow.start(jobId, { jobId, holdId: req.holdId, paymentRef: req.paymentRef });
    return json(202, { jobId, status: 'PENDING', statusUrl: `/tickets/${jobId}` }, { location: `/tickets/${jobId}` });
  });
}

export async function getTicketJob(ctx: AppContext, principal: string, jobId: string): Promise<HttpResponse> {
  if (!/^[0-9a-f-]{36}$/.test(jobId)) throw new HttpError(404, 'job-not-found', 'No such ticketing job');
  const item = await ctx.stateStore.get<JobItem>(jobPk(jobId));
  // Another client's job is indistinguishable from a missing one.
  if (!item || item.owner !== principal) throw new HttpError(404, 'job-not-found', 'No such ticketing job');
  const terminal = item.status === 'TICKETED' || item.status === 'FAILED';
  return json(200, publicJob(item), terminal ? {} : { 'retry-after': '2' });
}
