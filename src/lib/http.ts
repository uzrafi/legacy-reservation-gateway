import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { type Problem, toProblem, ValidationError } from './errors';
import { countMetric, flushMetrics, logger } from './observability';

export type HttpResponse = APIGatewayProxyResult & { headers: Record<string, string> };

export function header(event: Pick<APIGatewayProxyEvent, 'headers'>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(event.headers ?? {})) if (k.toLowerCase() === lower && v !== undefined) return v;
  return undefined;
}

export function json(statusCode: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  return { statusCode, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

export function problemResponse(err: unknown, instance?: string, headers: Record<string, string> = {}): HttpResponse {
  const p: Problem = toProblem(err);
  const { retryAfterSeconds, ...body } = p;
  const h: Record<string, string> = { 'content-type': 'application/problem+json', ...headers };
  if (retryAfterSeconds) h['retry-after'] = String(retryAfterSeconds);
  return { statusCode: p.status, headers: h, body: JSON.stringify({ ...body, ...(instance ? { instance } : {}) }) };
}

export function parseJsonBody(event: Pick<APIGatewayProxyEvent, 'body' | 'isBase64Encoded'>): unknown {
  if (!event.body) throw new ValidationError([{ path: '(body)', message: 'request body is required' }]);
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError([{ path: '(body)', message: 'body must be valid JSON' }]);
  }
}

export interface Caller {
  principalId: string;
  scopes: string[];
  apiKeyId?: string;
}

export function caller(event: APIGatewayProxyEvent): Caller {
  const auth = (event.requestContext?.authorizer ?? {}) as Record<string, unknown>;
  return {
    principalId: String(auth.principalId ?? 'anonymous'),
    scopes: String(auth.scopes ?? '')
      .split(' ')
      .filter(Boolean),
    apiKeyId: event.requestContext?.identity?.apiKeyId ?? undefined,
  };
}

/** Wraps an API Gateway proxy handler: errors -> problem+json, metrics, logging. */
export function httpHandler(route: string, fn: (event: APIGatewayProxyEvent) => Promise<HttpResponse>) {
  return async (event: APIGatewayProxyEvent): Promise<HttpResponse> => {
    const started = Date.now();
    const requestId = event.requestContext?.requestId ?? '';
    let res: HttpResponse;
    try {
      res = await fn(event);
    } catch (err) {
      res = problemResponse(err, event.path);
      if (res.statusCode >= 500) logger.error('request failed', { route, requestId, error: err as Error });
      else logger.info('request rejected', { route, requestId, status: res.statusCode, error: (err as Error).message });
    }
    countMetric('RequestLatencyMs', Date.now() - started, { route }, 'Milliseconds');
    countMetric(`Http${Math.floor(res.statusCode / 100)}xx`, 1, { route });
    flushMetrics();
    return res;
  };
}
