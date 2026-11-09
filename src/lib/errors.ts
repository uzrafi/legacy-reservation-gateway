/**
 * Error model. Legacy SOAP faults, timeouts and breaker rejections are turned
 * into RFC 9457 problem details here, and nowhere else.
 */
export const PROBLEM_BASE = 'https://github.com/uzrafi/legacy-reservation-gateway/blob/main/docs/problems.md#';

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  retryAfterSeconds?: number;
  errors?: Array<{ path: string; message: string }>;
}

/** An error with a known HTTP representation. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly slug: string,
    public readonly title: string,
    detail?: string,
    public readonly extra: Partial<Problem> = {},
  ) {
    super(detail ?? title);
    this.name = 'HttpError';
  }
  toProblem(): Problem {
    return { type: PROBLEM_BASE + this.slug, title: this.title, status: this.status, detail: this.message, ...this.extra };
  }
}

export class ValidationError extends HttpError {
  constructor(errors: Array<{ path: string; message: string }>) {
    super(400, 'validation-error', 'Request validation failed', errors.map((e) => `${e.path}: ${e.message}`).join('; '), {
      errors,
    });
  }
}

/** A SOAP fault returned by RESLINK/2: `<ERRCD>` plus `<ERRTX>`. */
export class LegacyFaultError extends Error {
  override name = 'LegacyFaultError';
  constructor(
    public readonly code: number,
    public readonly text: string,
  ) {
    super(`RESLINK fault ${code}: ${text}`);
  }
  get retryable(): boolean {
    return this.code >= 9000;
  }
  /** True when the host guarantees it did nothing (safe to retry even non-idempotent ops). */
  get rejectedBeforeProcessing(): boolean {
    return this.code === 9001;
  }
}

export class UpstreamTimeoutError extends Error {
  override name = 'UpstreamTimeoutError';
  readonly retryable = true;
}

/** Network failure, unexpected HTTP status, or unparseable response. */
export class UpstreamUnavailableError extends Error {
  override name = 'UpstreamUnavailableError';
  readonly retryable = true;
}

export class CircuitOpenError extends Error {
  override name = 'CircuitOpenError';
  readonly retryable = false;
  constructor(public readonly retryAfterMs: number) {
    super('circuit breaker is open for the legacy host');
  }
}

export function isRetryableUpstreamError(err: unknown): boolean {
  if (err instanceof LegacyFaultError) return err.retryable;
  return err instanceof UpstreamTimeoutError || err instanceof UpstreamUnavailableError;
}

/**
 * Errors that indicate the legacy host is unhealthy (they count against the circuit breaker).
 * "9001 busy" is backpressure from a healthy host, so it does not.
 */
export function isUpstreamHealthFailure(err: unknown): boolean {
  if (err instanceof LegacyFaultError && err.code === 9001) return false;
  return isRetryableUpstreamError(err);
}

const FAULT_MAP: Record<number, [number, string, string]> = {
  1001: [502, 'upstream-contract-error', 'The legacy system rejected a request the gateway believed was valid'],
  1002: [502, 'upstream-auth-failed', 'The gateway could not sign on to the legacy system'],
  2001: [404, 'flight-not-found', 'No flight serves this route or flight number'],
  2002: [404, 'seat-not-found', 'That seat does not exist on this aircraft'],
  3001: [409, 'seat-taken', 'That seat is not available'],
  3002: [404, 'hold-not-found', 'No such hold'],
  3003: [409, 'hold-expired', 'The hold has expired'],
  3004: [409, 'hold-not-active', 'The hold is no longer active'],
  4001: [402, 'payment-declined', 'The form of payment was declined'],
  9001: [503, 'upstream-busy', 'The legacy system is busy'],
  9002: [503, 'upstream-unavailable', 'The legacy system is unavailable'],
  9003: [502, 'upstream-error', 'The legacy system failed to process the request'],
};

export function toProblem(err: unknown): Problem {
  if (err instanceof HttpError) return err.toProblem();
  if (err instanceof LegacyFaultError) {
    const [status, slug, title] = FAULT_MAP[err.code] ?? [502, 'upstream-error', 'Unexpected legacy fault'];
    return {
      type: PROBLEM_BASE + slug,
      title,
      status,
      detail: `Legacy fault ${err.code}`,
      ...(status === 503 ? { retryAfterSeconds: 2 } : {}),
    };
  }
  if (err instanceof UpstreamTimeoutError) {
    return { type: PROBLEM_BASE + 'upstream-timeout', title: 'The legacy system did not answer in time', status: 504 };
  }
  if (err instanceof UpstreamUnavailableError) {
    return { type: PROBLEM_BASE + 'upstream-unavailable', title: 'The legacy system is unavailable', status: 503, retryAfterSeconds: 2 };
  }
  if ((err as Error)?.name === 'LegacyBusyError') {
    return { type: PROBLEM_BASE + 'upstream-busy', title: 'The legacy system is at capacity', status: 503, detail: 'Gateway-side rate limit for the legacy host reached', retryAfterSeconds: 1 };
  }
  if (err instanceof CircuitOpenError) {
    return {
      type: PROBLEM_BASE + 'upstream-unavailable',
      title: 'The legacy system is unavailable',
      status: 503,
      detail: 'Circuit breaker open; calls to the legacy system are paused',
      retryAfterSeconds: Math.max(1, Math.ceil(err.retryAfterMs / 1000)),
    };
  }
  return { type: PROBLEM_BASE + 'internal-error', title: 'Internal error', status: 500 };
}
