# Legacy Reservation Gateway

A clean, fast, secure **REST API** in front of a slow, fragile **legacy SOAP/XML reservation
system**, plus a **strangler-fig migration** of one operation off that system.
Node.js / TypeScript on AWS: API Gateway (usage plans, API keys, JWT authorizer), Lambda,
DynamoDB, Step Functions, S3, SSM, CloudWatch and X-Ray, all defined in Terraform.

[![ci](https://github.com/uzrafi/legacy-reservation-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/uzrafi/legacy-reservation-gateway/actions/workflows/ci.yml)

```
partners --x-api-key + JWT--> API Gateway (OpenAPI import, usage plans, authorizer, validation)
                                 | GET /fares, /seatmaps     | POST /holds        | POST /tickets -> 202
                                 v                           v                    v
                          read-through cache          idempotency keys     Step Functions (Standard)
                          (DynamoDB, SWR, TTL)        retry only if safe   retries + compensation
                                 \___________________________|____________________/
                                                             v
                           anti-corruption layer: JSON <-> SOAP/XML, timeouts, retries with
                           jitter and a budget, shared circuit breaker, fault translation
                                                             v
                                  RESLINK/2 (simulated legacy host): SOAP 1.1 + WSDL,
                                  600-1500 ms, injected faults, hangs, 5 req/s limit
```

Full diagram and the reasoning behind each choice: [docs/architecture.md](docs/architecture.md).

## Results

Measured on the **local harness** (real handlers, real SOAP host with injected latency and faults,
in-memory DynamoDB stand-in with 5 ms latency, the real Step Functions definition), with k6.
Raw numbers: [docs/results-local.md](docs/results-local.md) and [results/local/](results/local/).
The same experiments run against AWS with `npm run experiments -- --target aws`; those numbers will replace these.

| Experiment | Result |
|---|---|
| `GET /fares` direct to the legacy SOAP host (4 req/s) | p50 **1,070 ms**, p95 **1,470 ms**, p99 **10,879 ms** (injected 10 s hangs) |
| `GET /fares` through the gateway, 10 req/s, realistic route mix | p50 **17.4 ms**, p95 1,414 ms, p99 1,619 ms; **76.1%** cache hit rate; 0.03% errors; 56.8% of legacy calls avoided |
| Same, overload at 20 req/s (4x the host's capacity, cache still warming) | p50 16.4 ms, p95 3,279 ms; 78.5% hit rate; **5.95% of requests shed** with `503` instead of a collapse; 70.1% of legacy calls avoided |
| Legacy host failing **20%** of calls | client errors: unprotected **22.3%** → retries + breaker **4.2%** → full stack **0.83%** |
| Legacy host **100% down for 2 min** (after warm-up) | availability **100%** before, **65.9%** during, 93.9% after; breaker recovered **17.8 s** after the host came back |
| 100 ticketing jobs, legacy failing 20% of calls | **89/89** normal jobs ticketed (**100%**), p50 16.2 s, p95 23.4 s; **11/11** declined payments compensated (hold released) |
| Strangler fig: shadow comparison | mismatches **32.35%** (naive rules, 2,065 compared) → **0.00%** (fixed rules, 2,057 compared) |
| Strangler fig: canary 0 → 10 → 50 → 100% | **0 errors** at every step (4,800 requests) |
| Usage-plan throttling | AWS only, not measured yet |

Why p95 barely moves at 10 req/s: about a quarter of requests are first-time keys (24 routes × 60 days ×
4 classes ≈ 5,800 keys, and a 10-minute test cannot warm all of them), and every miss is a full
1-1.5 s legacy round trip. The cache changes the *typical* request (median 1,070 → 17 ms) and protects
the host, not the cold tail.

The first full run of these experiments exposed a retry storm (63% of requests failing at 20 req/s);
the fix is described in [docs/architecture.md](docs/architecture.md#bulkhead-and-admission-control).

### Resume bullets (from the measurements above)

- Built a **Node.js/TypeScript** REST gateway (API Gateway, Lambda, DynamoDB) in front of a simulated legacy **SOAP/XML** reservation system, cutting median fare-query latency from **1,070 ms to 17 ms** with a DynamoDB read-through cache (**76% hit rate**, 57% fewer legacy calls).
- Kept client-facing errors at **0.83%** (vs. **22%** unprotected) while the legacy system failed **20%** of calls, using timeouts, retries with jitter, a shared circuit breaker, gateway-side rate limiting and stale-cache fallback.
- Moved slow ticket issuance to an asynchronous **Step Functions** workflow with retries and a compensating seat release, completing **89/89** jobs (**100%**) under injected faults and releasing the hold on all 11 declined payments.
- Migrated fare quotes off the legacy system with the **strangler fig** pattern: shadow comparison cut mismatches from **32.3% to 0%**, then weighted Lambda aliases shifted traffic 10% → 100% with **zero errors**. Partner access managed with **API keys, usage plans and per-client throttling**, all in **Terraform**.

## What's in here

| Area | What it does | Where |
|---|---|---|
| **Legacy host (simulated)** | SOAP 1.1 + WSDL with the `soap` package. Fixed-width codes (`"YYZ  "`, `"AC0105"`), `DDMMMYY` dates, cents in zero-padded strings, numeric faults buried in `soap:Fault/detail`. Fault injection (latency, error rate, hangs, global 5 req/s limit) switchable at runtime. `IssueTicket` takes 5-20 s. Runs as a Lambda behind a Function URL, locally, or in Docker. | `src/legacy/` |
| **Anti-corruption layer** | All mapping JSON <-> XML, zod validation before the host sees anything, fault codes -> RFC 9457 problems. Unit tests on recorded XML fixtures plus a messy one per quirk. | `src/adapter/` |
| **Resilience** | Per-attempt timeouts, retries with full jitter inside a time budget (only for operations that are safe to retry), a circuit breaker with a shared "open" flag in DynamoDB and a single half-open probe, stale-cache fallback. | `src/resilience/` |
| **Caching** | DynamoDB read-through cache with TTL + stale-while-revalidate; single-flight refresh via conditional writes; async self-invoke for background refresh. Seat maps 15 s fresh, fares 5 min. | `src/cache/` |
| **Async ticketing** | `POST /tickets` -> `202` + job; Step Functions Standard workflow with declarative retries and a compensating `ReleaseHold`. The same ASL file runs locally through a small interpreter. | `infra/sfn/`, `src/app/ticket-worker.ts` |
| **Strangler fig** | Modern fare service fed by a nightly CSV export (S3 -> loader Lambda -> DynamoDB). Shadow mode compares every quote; Lambda weighted aliases shift 10% -> 50% -> 100% with alarm-based rollback. | `src/modern/`, `scripts/canary.ts`, [docs/migration.md](docs/migration.md) |
| **API management & security** | OpenAPI 3 is the source of truth, imported by API Gateway (validators, gateway responses). Two usage plans with API keys, RS256 JWT authorizer with scopes, SSM SecureString secrets, per-function IAM roles. | `openapi/openapi.yaml`, `src/handlers/authorizer.ts`, `infra/apigw.tf` |
| **Observability** | Powertools Logger/Metrics/Tracer; X-Ray subsegments per SOAP call and cache lookup; CloudWatch dashboard and alarms (circuit open 5 min, 5xx > 1%, mismatch > 0.1%). | `src/lib/observability.ts`, `infra/monitoring.tf` |
| **Infrastructure & CI** | Terraform (S3 backend with native locking), esbuild bundles, GitHub Actions: lint/test, `fmt`/`validate`/`plan` on PRs, `apply` + integration tests on `main` via GitHub OIDC. | `infra/`, `.github/workflows/` |

## Run it locally (no AWS needed)

```bash
npm ci
npm test                 # unit + contract tests
npm run local            # legacy host on :9081, gateway on :9080
```

```bash
curl "http://127.0.0.1:9080/fares?origin=YYZ&destination=YVR&date=2026-12-01"
curl "http://127.0.0.1:9080/seatmaps/AC105?date=2026-12-01"
curl "http://127.0.0.1:9081/reslink?wsdl"
npm run faults -- set errorRate=0.2      # make the legacy host fail 20% of calls
npm run experiments -- --target local    # every measurement below, about 40 minutes
```

The local harness runs the real Lambda handlers with in-memory stand-ins for DynamoDB,
executes the real Step Functions definition with `src/local/asl-runner.ts`, and emulates the
weighted alias for the canary. The legacy host alone also runs in Docker:
`docker build -f Dockerfile.legacy -t reslink-legacy . && docker run -p 9081:9081 reslink-legacy`.

## Deploy to AWS

See [docs/deploy-aws.md](docs/deploy-aws.md): bootstrap (state bucket, GitHub OIDC roles,
$5 budget), `npm run build`, `terraform apply`, then `npm run experiments -- --target aws`.

## API

| Method | Path | Scope | Notes |
|---|---|---|---|
| GET | `/fares?origin&destination&date&fareClass` | `fares:read` | `x-cache`, `Age`, `Warning` headers |
| GET | `/seatmaps/{flightNumber}?date` | `fares:read` | 15 s freshness |
| POST | `/holds` | `holds:write` | `Idempotency-Key` required; 15-minute hold |
| POST | `/tickets` | `tickets:write` | `202 Accepted` + job |
| GET | `/tickets/{jobId}` | `tickets:write` | `PENDING`, `RUNNING`, `TICKETED`, `FAILED` (+ `failureReason`, `compensated`) |

Errors: [docs/problems.md](docs/problems.md). Contract: [openapi/openapi.yaml](openapi/openapi.yaml)
(also published as Swagger UI on S3 by Terraform).

## Cost

About **$0-5 total** at test volumes, if you `terraform destroy` afterwards.

| Service | Expectation |
|---|---|
| Lambda, DynamoDB on-demand, S3, SSM standard parameters, X-Ray | Free tier or cents |
| API Gateway REST | Per million requests; the experiments make about 30 000 calls (cents) |
| Step Functions Standard | Per state transition; 100 jobs is about 700 transitions (inside the free tier) |
| CloudWatch custom metrics | Billed per metric-hour only while metrics are being sent |
| Avoided on purpose | API Gateway cache (hourly), NAT gateways, Secrets Manager |

## More

- [docs/architecture.md](docs/architecture.md): diagram and design decisions
- [docs/migration.md](docs/migration.md): the strangler-fig write-up
- [docs/interview-notes.md](docs/interview-notes.md): the trade-offs, briefly
- [docs/results-local.md](docs/results-local.md): raw measurements
