# Problem types

Every error from the gateway is an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)
`application/problem+json` document whose `type` points at an anchor on this page.

```json
{
  "type": "https://github.com/uzrafi/legacy-reservation-gateway/blob/main/docs/problems.md#seat-taken",
  "title": "That seat is not available",
  "status": 409,
  "detail": "Legacy fault 3001",
  "instance": "/holds"
}
```

| Anchor | Status | Meaning | Retry? | Legacy fault |
|---|---|---|---|---|
| <a id="validation-error"></a>`validation-error` | 400 | The request failed validation; `errors[]` lists each field. | No | (caught before the legacy host) |
| <a id="idempotency-key-required"></a>`idempotency-key-required` | 400 | `POST /holds` and `POST /tickets` need an `Idempotency-Key` header. | No | |
| <a id="unauthorized"></a>`unauthorized` | 401 | Missing, expired or invalid bearer token. | No | |
| <a id="forbidden"></a>`forbidden` | 403 | The token lacks the scope this route needs. | No | |
| <a id="invalid-api-key"></a>`invalid-api-key` | 403 | Missing or unknown `x-api-key`. | No | |
| <a id="payment-declined"></a>`payment-declined` | 402 | The form of payment was declined. | No | 4001 |
| <a id="flight-not-found"></a>`flight-not-found` | 404 | No flight serves this route or flight number. | No | 2001 |
| <a id="seat-not-found"></a>`seat-not-found` | 404 | That seat does not exist on the aircraft. | No | 2002 |
| <a id="hold-not-found"></a>`hold-not-found` | 404 | No such hold. | No | 3002 |
| <a id="job-not-found"></a>`job-not-found` | 404 | No such ticketing job (or it belongs to another client). | No | |
| <a id="seat-taken"></a>`seat-taken` | 409 | The seat is held or sold. | No | 3001 |
| <a id="hold-expired"></a>`hold-expired` | 409 | The 15-minute hold expired. | No | 3003 |
| <a id="hold-not-active"></a>`hold-not-active` | 409 | The hold was released or already ticketed. | No | 3004 |
| <a id="request-in-progress"></a>`request-in-progress` | 409 | The same `Idempotency-Key` is still being processed. | After `Retry-After` | |
| <a id="idempotency-key-reused"></a>`idempotency-key-reused` | 422 | The `Idempotency-Key` was used before with a different body. | No | |
| <a id="throttled"></a>`throttled` | 429 | Over the usage plan's requests per second. | After `Retry-After` | |
| <a id="quota-exceeded"></a>`quota-exceeded` | 429 | The usage plan's daily quota is used up. | Tomorrow | |
| <a id="upstream-contract-error"></a>`upstream-contract-error` | 502 | The legacy host rejected a request the gateway believed valid (a mapping bug). | No | 1001 |
| <a id="upstream-auth-failed"></a>`upstream-auth-failed` | 502 | The gateway could not sign on to the legacy host. | No | 1002 |
| <a id="upstream-error"></a>`upstream-error` | 502 | The legacy host failed internally. | Yes | 9003 |
| <a id="upstream-busy"></a>`upstream-busy` | 503 | The legacy host is over its rate limit. | After `Retry-After` | 9001 |
| <a id="upstream-unavailable"></a>`upstream-unavailable` | 503 | The legacy host is down, or the circuit breaker is open. | After `Retry-After` | 9002 |
| <a id="upstream-timeout"></a>`upstream-timeout` | 504 | The legacy host did not answer within the time budget. | Yes | |
| <a id="internal-error"></a>`internal-error` | 500 | A bug in the gateway. | Maybe | |
