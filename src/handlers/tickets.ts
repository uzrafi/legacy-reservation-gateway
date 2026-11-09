/** POST /tickets (202 + job) and GET /tickets/{jobId}. */
import { getContext } from '../app/context';
import { requireIdempotencyKey } from '../app/idempotency';
import { getTicketJob, startTicketJob } from '../app/tickets';
import { caller, header, httpHandler, parseJsonBody } from '../lib/http';

export const handler = httpHandler('tickets', async (event) => {
  const ctx = getContext();
  const who = caller(event).principalId;
  if (event.httpMethod === 'GET') return getTicketJob(ctx, who, event.pathParameters?.jobId ?? '');
  const key = requireIdempotencyKey(header(event, 'idempotency-key'));
  return startTicketJob(ctx, who, key, parseJsonBody(event));
});
