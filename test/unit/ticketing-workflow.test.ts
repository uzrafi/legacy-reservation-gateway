/**
 * Runs the real state machine definition (infra/sfn/ticketing.asl.json) through
 * the local ASL runner, with the real worker steps and a scripted legacy client.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContext } from '../../src/app/context';
import { runStep, type StepName, type WorkflowInput } from '../../src/app/ticket-worker';
import { type JobItem, jobPk } from '../../src/app/tickets';
import { LegacyFaultError, UpstreamTimeoutError } from '../../src/lib/errors';
import { runStateMachine, type StateMachine } from '../../src/local/asl-runner';
import { MemoryKvStore } from '../../src/store/kv';

const asl = JSON.parse(readFileSync(path.join(__dirname, '../../infra/sfn/ticketing.asl.json'), 'utf8')) as StateMachine;

type Script = Partial<Record<'getHoldStatus' | 'issueTicket' | 'releaseHold', Array<unknown>>>;

async function run(script: Script) {
  const stateStore = new MemoryKvStore();
  const ctx = buildContext({ stateStore, cacheStore: new MemoryKvStore(), faresStore: new MemoryKvStore() });
  const calls: Record<string, number> = {};
  const next = (op: keyof Script, fallback: unknown) => {
    calls[op] = (calls[op] ?? 0) + 1;
    const q = script[op];
    const v = q && q.length ? q.shift() : fallback;
    if (v instanceof Error) throw v;
    return { data: v, meta: { attempts: 1 } };
  };
  ctx.legacy.getHoldStatus = (async () => next('getHoldStatus', { status: 'held' })) as never;
  ctx.legacy.issueTicket = (async () => next('issueTicket', { ticketNumber: '0141234567890', holdId: 'HABCDEF1' })) as never;
  ctx.legacy.releaseHold = (async () => next('releaseHold', { holdId: 'HABCDEF1', status: 'released' })) as never;

  const jobId = '00000000-0000-0000-0000-000000000001';
  const now = new Date().toISOString();
  await stateStore.put<JobItem>({ pk: jobPk(jobId), jobId, owner: 'c', status: 'PENDING', holdId: 'HABCDEF1', createdAt: now, updatedAt: now, ttl: 0 });

  const result = await runStateMachine(asl, { jobId, holdId: 'HABCDEF1', paymentRef: 'PAY-1' }, {
    timeScale: 0,
    invoke: async (_r, payload) => {
      const p = payload as { step: StepName; input: WorkflowInput };
      return runStep(ctx, p.step, p.input);
    },
  });
  const job = await stateStore.get<JobItem>(jobPk(jobId));
  return { result, job, calls };
}

describe('ticketing state machine', () => {
  test('happy path: check -> issue -> confirm', async () => {
    const { result, job } = await run({});
    expect(result.status).toBe('SUCCEEDED');
    expect(result.transitions).toEqual(['MarkRunning', 'CheckHold', 'HoldValid?', 'IssueTicket', 'Confirm']);
    expect(job).toMatchObject({ status: 'TICKETED', ticketNumber: '0141234567890' });
  });

  test('retryable legacy faults and timeouts are retried by the workflow', async () => {
    const { result, job, calls } = await run({
      issueTicket: [new LegacyFaultError(9002, 'HOST UNAVAILABLE'), new UpstreamTimeoutError('slow'), { ticketNumber: '0149999999999' }],
    });
    expect(result.status).toBe('SUCCEEDED');
    expect(calls.issueTicket).toBe(3);
    expect(job?.ticketNumber).toBe('0149999999999');
  });

  test('declined payment -> compensating ReleaseHold -> FAILED', async () => {
    const { result, job, calls } = await run({ issueTicket: [new LegacyFaultError(4001, 'DECLINED')] });
    expect(result.status).toBe('FAILED');
    expect(result.transitions).toEqual(['MarkRunning', 'CheckHold', 'HoldValid?', 'IssueTicket', 'ReleaseHold', 'MarkFailed', 'Failed']);
    expect(calls.issueTicket).toBe(1); // not retried
    expect(job).toMatchObject({ status: 'FAILED', failureReason: 'payment_declined', compensated: true });
  });

  test('legacy keeps failing -> retries exhausted -> compensation', async () => {
    const down = () => new LegacyFaultError(9002, 'HOST UNAVAILABLE');
    const { result, job, calls } = await run({ issueTicket: [down(), down(), down(), down(), down(), down()] });
    expect(result.status).toBe('FAILED');
    expect(calls.issueTicket).toBe(5); // 1 + MaxAttempts 4
    expect(job).toMatchObject({ failureReason: 'upstream_unavailable', compensated: true });
  });

  test('expired hold -> no ticket attempt, no compensation needed', async () => {
    const { result, job, calls } = await run({ getHoldStatus: [{ status: 'expired' }] });
    expect(result.status).toBe('FAILED');
    expect(calls.issueTicket).toBeUndefined();
    expect(job).toMatchObject({ status: 'FAILED', failureReason: 'hold_not_valid', compensated: false });
  });

  test('compensation itself retries through a transient outage', async () => {
    const { job, calls } = await run({
      issueTicket: [new LegacyFaultError(4001, 'DECLINED')],
      releaseHold: [new LegacyFaultError(9001, 'BUSY'), new LegacyFaultError(9002, 'DOWN'), { holdId: 'HABCDEF1', status: 'released' }],
    });
    expect(calls.releaseHold).toBe(3);
    expect(job?.compensated).toBe(true);
  });
});
