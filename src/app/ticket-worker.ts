/**
 * Steps of the ticketing workflow (infra/sfn/ticketing.asl.json). Each step makes
 * at most one legacy call; retries, back-off, and compensation are declared in
 * the state machine, not coded here. Errors are thrown with stable names because
 * Step Functions matches Retry/Catch rules on the error name.
 */
import { CircuitOpenError, LegacyFaultError, UpstreamTimeoutError, UpstreamUnavailableError } from '../lib/errors';
import { countMetric, logger } from '../lib/observability';
import type { AppContext } from './context';
import { updateJob } from './tickets';

export class StepError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

/** Legacy errors -> workflow error names the ASL Retry/Catch rules match on. */
export function toStepError(err: unknown): Error {
  if (err instanceof StepError) return err;
  if (err instanceof UpstreamTimeoutError) return new StepError('LegacyTimeoutError', err.message);
  if (err instanceof CircuitOpenError || err instanceof UpstreamUnavailableError || (err as Error)?.name === 'LegacyBusyError') {
    return new StepError('LegacyRetryableError', (err as Error).message);
  }
  if (err instanceof LegacyFaultError) {
    if (err.retryable) return new StepError('LegacyRetryableError', err.message);
    if (err.code === 4001) return new StepError('PaymentDeclinedError', err.message);
    if ([3002, 3003, 3004].includes(err.code)) return new StepError('HoldNotValidError', err.message);
    return new StepError('TicketingError', err.message);
  }
  return err instanceof Error ? err : new Error(String(err));
}

export interface WorkflowInput {
  jobId: string;
  holdId: string;
  paymentRef: string;
  hold?: { valid: boolean; status: string };
  ticket?: { ticketNumber: string };
  release?: { released: boolean; status: string };
  error?: { Error: string; Cause?: string };
  compensationError?: { Error: string; Cause?: string };
}

export type StepName = 'markRunning' | 'checkHold' | 'issueTicket' | 'confirm' | 'releaseHold' | 'markFailed';

const FAILURE_REASON: Record<string, string> = {
  HoldNotValidError: 'hold_not_valid',
  PaymentDeclinedError: 'payment_declined',
  LegacyRetryableError: 'upstream_unavailable',
  LegacyTimeoutError: 'upstream_timeout',
  'States.Timeout': 'upstream_timeout',
};

export async function runStep(ctx: AppContext, step: StepName, input: WorkflowInput): Promise<unknown> {
  try {
    switch (step) {
      case 'markRunning':
        await updateJob(ctx.stateStore, input.jobId, { status: 'RUNNING' });
        return {};

      case 'checkHold': {
        const { data } = await ctx.legacy.getHoldStatus(input.holdId);
        // A hold that is already ticketed is fine: IssueTicket is idempotent per hold.
        return { valid: data.status === 'held' || data.status === 'ticketed', status: data.status };
      }

      case 'issueTicket': {
        const { data } = await ctx.legacy.issueTicket({ holdId: input.holdId, paymentRef: input.paymentRef });
        return { ticketNumber: data.ticketNumber };
      }

      case 'confirm':
        await updateJob(ctx.stateStore, input.jobId, { status: 'TICKETED', ticketNumber: input.ticket!.ticketNumber });
        countMetric('TicketJobsSucceeded', 1);
        return {};

      case 'releaseHold': {
        try {
          const { data } = await ctx.legacy.releaseHold(input.holdId);
          countMetric('TicketCompensations', 1);
          return { released: true, status: data.status };
        } catch (err) {
          // Nothing to release.
          if (err instanceof LegacyFaultError && err.code === 3002) return { released: false, status: 'not_found' };
          throw err;
        }
      }

      case 'markFailed': {
        const errName = input.error?.Error ?? 'TicketingError';
        await updateJob(ctx.stateStore, input.jobId, {
          status: 'FAILED',
          failureReason: FAILURE_REASON[errName] ?? 'ticketing_error',
          compensated: input.release?.released === true,
        });
        countMetric('TicketJobsFailed', 1, { reason: FAILURE_REASON[errName] ?? 'ticketing_error' });
        if (input.compensationError) logger.error('compensation failed', { jobId: input.jobId, error: input.compensationError });
        return {};
      }
    }
  } catch (err) {
    const stepErr = toStepError(err);
    logger.info('workflow step failed', { step, jobId: input.jobId, error: stepErr.name, message: stepErr.message });
    throw stepErr;
  }
}
