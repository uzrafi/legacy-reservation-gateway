/**
 * Logging, metrics and tracing.
 *  - On Lambda: Powertools Logger (JSON), Metrics (CloudWatch EMF) and Tracer (X-Ray).
 *  - Locally: same logger; metrics also land in an in-process registry so the local
 *    harness can expose them (GET /__local/stats) for experiments without AWS.
 */
import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { Tracer } from '@aws-lambda-powertools/tracer';

const serviceName = process.env.POWERTOOLS_SERVICE_NAME ?? 'reservation-gateway';
export const inLambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);

export const logger = new Logger({ serviceName, logLevel: (process.env.LOG_LEVEL as 'INFO') ?? 'INFO' });
export const tracer = new Tracer({ serviceName, enabled: inLambda && process.env.POWERTOOLS_TRACE_DISABLED !== 'true' });
const metrics = new Metrics({ namespace: process.env.METRICS_NAMESPACE ?? 'ReservationGateway', serviceName });

type Unit = 'Count' | 'Milliseconds' | 'Percent' | 'None';
const UNIT: Record<Unit, (typeof MetricUnit)[keyof typeof MetricUnit]> = {
  Count: MetricUnit.Count,
  Milliseconds: MetricUnit.Milliseconds,
  Percent: MetricUnit.Percent,
  None: MetricUnit.NoUnit,
};

// ----------------------------------------------------------- local registry
const counters = new Map<string, number>();
const samples = new Map<string, number[]>();

function key(name: string, dims?: Record<string, string>) {
  if (!dims || Object.keys(dims).length === 0) return name;
  return `${name}{${Object.entries(dims)
    .map(([k, v]) => `${k}=${v}`)
    .join(',')}}`;
}

export function localMetricsSnapshot() {
  const latency: Record<string, { count: number; p50: number; p95: number; p99: number }> = {};
  for (const [k, arr] of samples) {
    const s = [...arr].sort((a, b) => a - b);
    const pick = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
    latency[k] = { count: s.length, p50: pick(0.5), p95: pick(0.95), p99: pick(0.99) };
  }
  return { counters: Object.fromEntries(counters), latency };
}

export function resetLocalMetrics() {
  counters.clear();
  samples.clear();
}

/**
 * Records a metric. Dimensioned metrics use a single-metric EMF blob so that
 * each keeps its own dimension set.
 */
export function countMetric(name: string, value = 1, dims?: Record<string, string>, unit: Unit = 'Count') {
  const k = key(name, dims);
  if (unit === 'Milliseconds') {
    const arr = samples.get(k) ?? [];
    if (arr.length < 200_000) arr.push(value);
    samples.set(k, arr);
  } else {
    counters.set(k, (counters.get(k) ?? 0) + value);
  }
  if (!inLambda) return;
  if (dims && Object.keys(dims).length > 0) {
    const single = metrics.singleMetric();
    for (const [dk, dv] of Object.entries(dims)) single.addDimension(dk, dv);
    single.addMetric(name, UNIT[unit], value);
  } else {
    metrics.addMetric(name, UNIT[unit], value);
  }
}

export function flushMetrics() {
  if (inLambda) metrics.publishStoredMetrics();
}

/** Runs fn in an X-Ray subsegment (no-op when tracing is off). */
export async function traced<T>(name: string, fn: () => Promise<T>, annotations?: Record<string, string | number | boolean>): Promise<T> {
  if (!tracer.isTracingEnabled()) return fn();
  const parent = tracer.getSegment();
  if (!parent) return fn();
  const sub = parent.addNewSubsegment(name);
  tracer.setSegment(sub);
  try {
    for (const [k, v] of Object.entries(annotations ?? {})) sub.addAnnotation(k, v);
    return await fn();
  } catch (err) {
    sub.addError(err as Error);
    throw err;
  } finally {
    sub.close();
    tracer.setSegment(parent);
  }
}

export function annotate(k: string, v: string | number | boolean) {
  if (tracer.isTracingEnabled()) tracer.putAnnotation(k, v);
}
