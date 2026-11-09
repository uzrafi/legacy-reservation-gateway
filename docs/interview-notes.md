# Interview talking points

Short answers to the questions this project is built to provoke, with pointers into the code.

### 1. Why an anti-corruption layer?
The legacy host's model (fixed-width codes, `DDMMMYY`, cents-in-strings, numeric faults) would
otherwise leak into every handler, the public contract and every partner integration, and it
would have to be unlearned when the host is retired. One module (`src/adapter`) owns the
translation, has fixture tests for each quirk, and is the only thing that changes when the
backend changes. The strangler-fig migration is cheap precisely because the public API never
knew about SOAP.

### 2. Which operations are safe to retry? Why does a retry budget matter?
Reads, and writes the host deduplicates (IssueTicket per hold, ReleaseHold). `HoldSeat` is not
idempotent: after a timeout the seat may or may not be held, so it is retried only on 9001
("busy, nothing done"). Callers get idempotency at *our* layer through `Idempotency-Key`.
Without a total time budget, each layer's retries multiply (3 client retries x 3 gateway
retries x ...), arrive after the caller has given up, and turn a brownout into an outage: a
retry storm. Here every attempt's timeout is clipped to the remaining budget and jitter
spreads retries out (`src/resilience/retry.ts`).

### 3. Circuit breaker state in serverless
Instance-local state means N instances each need their own failures to trip, and cold
instances start closed. That is the worst case during an outage, because slow responses cause
scale-out. A shared `openUntil` flag in DynamoDB (cached ~1 s) makes the fleet back off
together, and a conditional-write lease allows one half-open probe for the whole fleet. Trade-
offs: one DynamoDB read per instance-second, ~1 s propagation lag, and a dependency on
DynamoDB, so the breaker degrades to local-only state if that read fails.

### 4. Stale-while-revalidate vs. plain TTL
A plain TTL creates synchronized expiry: every popular key misses at once and the burst hits a
5 req/s host. SWR serves the stale value immediately and refreshes once, under a lock, in the
background (an async self-invoke, because Lambda freezes after returning). It also gives a
natural degraded mode: when the host is down, stale data is served with `Warning` and `Age`.

### 5. Why 202 for tickets? Standard vs. Express?
Issuing takes 5-20 s plus retries; holding an HTTP connection that long ties up clients,
API Gateway (29 s limit) and Lambda concurrency, and a dropped connection leaves the caller
unsure whether a ticket exists. A job resource makes the operation observable and resumable.
Step Functions owns retries/backoff/timeouts and the compensating `ReleaseHold` declaratively.
Standard: long-running, exactly-once start by execution name (our job id), full history.
Express is cheaper and faster for high-volume, short, at-least-once work, which this is not.

### 6. The strangler-fig migration
v2 (DynamoDB fares from the nightly export) first ran in shadow mode: serve legacy, compare
with v2, log and count differences. That surfaced two real rule gaps (weekend surcharge column,
J vs C class code) plus an irreducible floor from intraday re-filings the nightly feed cannot
see. After fixing the rules the mismatch rate fell under the 0.1% threshold, and traffic moved
10% -> 50% -> 100% with Lambda weighted aliases, gated by CloudWatch alarms on 5xx rate and
sampled mismatch rate, with automatic rollback. See [migration.md](migration.md).

### 7. API management
Usage plans + API keys give a partner program per-client rate limits, burst limits and daily
quotas, plus usage reporting from access logs keyed by API key. Apigee models the same thing as
API products with quota and spike-arrest policies; MuleSoft API Manager as SLA tiers with
rate-limiting policies; both add developer portals and monetisation on top.

### 8. SOAP vs. REST vs. gRPC
SOAP: contract-first (WSDL/XSD), verbose XML, WS-* standards (security, transactions), still
common in airline and banking cores. REST/JSON: resource-oriented, cache-friendly over HTTP,
easy for partners, described with OpenAPI. gRPC: contract-first again (protobuf), compact
binary over HTTP/2, streaming, great between internal services, awkward for browsers and
public partner APIs. This gateway is REST outward and SOAP inward, which is the usual shape of
a modernization facade.
