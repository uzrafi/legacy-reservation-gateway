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

RESULTS_PLACEHOLDER

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
