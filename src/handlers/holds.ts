/** POST /holds (Idempotency-Key required). */
import { getContext } from '../app/context';
import { requireIdempotencyKey } from '../app/idempotency';
import { createHold } from '../app/tickets';
import { caller, header, httpHandler, parseJsonBody } from '../lib/http';

export const handler = httpHandler('POST /holds', async (event) => {
  const key = requireIdempotencyKey(header(event, 'idempotency-key'));
  return createHold(getContext(), caller(event).principalId, key, parseJsonBody(event));
});
