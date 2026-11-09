/** GET /fares, plus background revalidation events (async self-invoke). */
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { getContext, type RevalidationRequest, setInvokedFunctionArn } from '../app/context';
import { experimentFlags, getFare, refreshFare } from '../app/fares';
import { header, httpHandler, json } from '../lib/http';
import { logger } from '../lib/observability';
import { freshnessHeaders } from './common';

const http = httpHandler('GET /fares', async (event) => {
  const ctx = getContext();
  const flags = experimentFlags(header(event, 'x-experiment'), ctx.config.allowExperimentHeaders);
  const r = await getFare(ctx, event.queryStringParameters ?? {}, flags);
  return json(200, { ...r.quote, source: r.source }, {
    ...freshnessHeaders(r.cache, r.ageSeconds, r.degraded, ctx.legacy.breakerState),
    'x-fare-source': r.source,
    'x-fare-mode': ctx.config.fareMode,
    'x-function-version': process.env.AWS_LAMBDA_FUNCTION_VERSION ?? 'local',
  });
});

export async function handler(event: APIGatewayProxyEvent | { revalidate: RevalidationRequest }, context?: Context) {
  setInvokedFunctionArn(context?.invokedFunctionArn);
  if ('revalidate' in event) {
    const { key, query } = event.revalidate;
    await refreshFare(getContext(), key, query).catch((err) => logger.warn('fare revalidation failed', { key, error: (err as Error).message }));
    return { ok: true };
  }
  return http(event);
}
