/** GET /seatmaps/{flightNumber}?date=, plus background revalidation events. */
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { getContext, type RevalidationRequest, setInvokedFunctionArn } from '../app/context';
import { experimentFlags } from '../app/fares';
import { getSeatMap, refreshSeatMap } from '../app/seatmaps';
import { header, httpHandler, json } from '../lib/http';
import { logger } from '../lib/observability';
import { freshnessHeaders } from './common';

const http = httpHandler('GET /seatmaps', async (event) => {
  const ctx = getContext();
  const flags = experimentFlags(header(event, 'x-experiment'), ctx.config.allowExperimentHeaders);
  const r = await getSeatMap(ctx, { flightNumber: event.pathParameters?.flightNumber, date: event.queryStringParameters?.date }, flags);
  return json(200, r.seatMap, freshnessHeaders(r.cache, r.ageSeconds, r.degraded, ctx.legacy.breakerState));
});

export async function handler(event: APIGatewayProxyEvent | { revalidate: RevalidationRequest }, context?: Context) {
  setInvokedFunctionArn(context?.invokedFunctionArn);
  if ('revalidate' in event) {
    const { key, query } = event.revalidate;
    await refreshSeatMap(getContext(), key, query).catch((err) => logger.warn('seat map revalidation failed', { key, error: (err as Error).message }));
    return { ok: true };
  }
  return http(event);
}
