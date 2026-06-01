# Phase 4 — Backend Design

## 1. Goals

The backend has four jobs: (1) be the only path through which the world reaches user data, (2) be the only path through which a user's intent reaches the automation/AI layers, (3) maintain durable run state across crashes, and (4) be observable enough that any incident can be reconstructed from logs and traces alone.

Concretely, this phase covers:
- The API gateway's surface and conventions (auth, validation, errors, idempotency, rate limits).
- The orchestrator's state machine, command bus, and resumability guarantees.
- The internal contracts between API ↔ orchestrator ↔ workers ↔ AI service.
- Cross-cutting backend concerns: configuration, logging, tracing, error taxonomy, testing.

## 2. Stack and conventions (recap + extensions)

- **Runtime:** Node.js 20 LTS.
- **Language:** TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- **Framework:** NestJS with Fastify adapter. Why NestJS: dependency injection, modular boundaries, guards/pipes/interceptors that align with our cross-cutting concerns. Why Fastify: ~3× the raw throughput of Express; mature schema-driven validation hooks.
- **Validation:** Zod everywhere. Nest's `ValidationPipe` is replaced with a project-wide `ZodPipe` that validates DTOs against schemas in `packages/shared-types/api`.
- **HTTP client:** `undici` for service-to-service; `got` for external (job platform APIs that we treat as last-resort fallbacks).
- **Error model:** typed hierarchy in `packages/shared-errors`; never throw `new Error(...)` outside that package.
- **Logging:** `pino` via `packages/shared-logger`; structured JSON; PII redaction by default (allowlist of safe fields).
- **Tracing:** OpenTelemetry SDK auto-instruments HTTP, Prisma, BullMQ, undici, ioredis. Manual spans wrap business operations (`run.start`, `apply.submit`, `ai.score.batch`).
- **Metrics:** Prometheus via `prom-client`; histograms for latency, counters for outcomes.
- **Time:** all timestamps UTC; the API serializes `TIMESTAMPTZ` as ISO-8601. The frontend renders local time.
- **IDs:** ULID for opaque external identifiers exposed to clients (sortable, URL-safe); UUIDv4 internal.

## 3. The API gateway (`apps/api`)

### 3.1 Surface
The public surface is a versioned REST API at `/api/v1`. We choose REST over GraphQL because:
- The dashboard is read-heavy on a finite, well-understood set of resources; REST + TanStack Query gives us caching, retries, and devtools out of the box.
- Commands are imperative; REST mutations are easier to reason about for idempotency and audit than mutation strings.
- A future GraphQL gateway can sit in front of REST without changing the underlying semantics.

OpenAPI 3.1 is generated from the Zod schemas via `@asteasolutions/zod-to-openapi`. The web client's typed SDK is generated from that OpenAPI doc and lives at `apps/web/src/lib/api-client/`.

### 3.2 Modules

The API is organized as one Nest module per resource. Module names match URL prefixes 1:1.

| Module | Purpose | Notable endpoints |
| --- | --- | --- |
| `auth` | Sign-up, sign-in, WebAuthn, TOTP, sessions, MFA recovery | `POST /auth/sign-in`, `POST /auth/webauthn/{begin,finish}`, `POST /auth/sessions/revoke` |
| `users` | Profile read/write, account lifecycle, data export | `GET /me`, `PATCH /me/profile`, `POST /me/export` |
| `personal-info` | Sensitive fields (DoB, phone, address) — gated path | `GET /me/personal-info`, `PATCH /me/personal-info` |
| `educations`, `experiences`, `projects`, `skills`, `links` | Normalized profile entries | CRUD per resource |
| `frequent-answers` | Locked answers for common Qs | CRUD; PATCH supports `is_locked` |
| `qa-memory` | Recall and edit AI-generated answer memory | GET, PATCH, DELETE |
| `resumes` | Resume CRUD; version history; tailoring requests | `POST /resumes`, `POST /resumes/{id}/versions`, `POST /resumes/{id}/tailor` |
| `platforms` | List supported platforms; static catalog | `GET /platforms` |
| `platform-accounts` | Connect/disconnect accounts; permission scopes | `POST /platform-accounts`, `PATCH /platform-accounts/{id}/permissions` |
| `runs` | Start/pause/resume/stop runs; list & inspect | `POST /runs`, `POST /runs/{id}/{pause,resume,stop}`, `GET /runs/{id}` |
| `applications` | Search, inspect, override status, withdraw | `GET /applications`, `GET /applications/{id}`, `POST /applications/{id}/withdraw` |
| `analytics` | Dashboards, time series, funnels | `GET /analytics/overview?bucket=...&platform=...` |
| `notifications` | List, mark read, settings | `GET /notifications`, `POST /notifications/read` |
| `audit` | User-visible activity log | `GET /audit?since=...` |
| `optimization` | Profile review + resume review suggestions; approve/reject | `POST /optimization/review`, `POST /optimization/{suggestion_id}/{approve,reject}` |
| `health` | Liveness/readiness for k8s | `GET /healthz`, `GET /readyz` |

Internal-only endpoints (mTLS, allowlisted callers): `/internal/runs/*` for the orchestrator to acknowledge transitions; the worker never calls the API.

### 3.3 Auth & sessions

- Session cookie: `__Host-apex_sid`, `Secure; HttpOnly; SameSite=Lax; Path=/`. The cookie carries a 32-byte random session id; the DB stores `SHA-256(session_id)` only.
- CSRF: double-submit token for non-GET requests; the token is a short HMAC of the session id and the request path prefix.
- WebAuthn (FIDO2) is the primary second factor. TOTP is offered as fallback.
- Step-up authentication: any operation that touches `personal-info`, `platform_credentials`, or `permissions.grant` requires a fresh MFA proof within the last 10 minutes; otherwise the API returns `401 mfa_required`.
- The session model carries a `data_key_handle` — an in-memory reference managed by the API process to the user's unwrapped DEK for the current session. On logout / TTL, it is wiped.

### 3.4 Authorization

Two layers, applied in order by Nest guards:

1. **RBAC.** Roles: `owner`, `viewer`, `automation_bot`. Most users are `owner`; viewer is for shared-read scenarios in M9.
2. **Permission scopes.** Fine-grained capabilities like `resume.edit.global`, `resume.edit.linkedin`, `profile.edit`, `platform.connect`, `run.start`. Scopes are evaluated per request via a `@RequirePermission('resume.edit.linkedin')` decorator that consults `user_permissions` with the optional `scope` JSON.

Default policy: deny. There is no implicit grant.

### 3.5 Validation, idempotency, rate limiting

- **Validation.** Every controller method declares its input as a Zod schema imported from `packages/shared-types/api`. Failures yield a `ValidationError` mapped to `400` with a machine-readable `issues[]`.
- **Idempotency.** Mutating endpoints accept `Idempotency-Key`. The API stores `key → response_envelope` with a 24-hour TTL in Redis (and a backstop in PG for >24h dedupe). A repeat with the same key returns the cached response, byte-for-byte.
- **Rate limiting.** Token bucket per principal + per IP, in Redis. Tiered: `auth.*` is strict (5 req / 5 min for `sign-in`), `runs.start` is strict (10 / hour), reads are generous. Exceeded buckets return `429 Retry-After`.

### 3.6 Error model

`packages/shared-errors` exports a hierarchy:

```
ApexError
├── ValidationError         -> 400
├── AuthError
│   ├── UnauthenticatedError -> 401
│   ├── MfaRequiredError     -> 401 (code: mfa_required)
│   └── ForbiddenError       -> 403
├── NotFoundError           -> 404
├── ConflictError           -> 409 (idempotency mismatch, unique violations)
├── PreconditionFailedError -> 412 (state machine refused)
├── RateLimitedError        -> 429
├── DependencyError         -> 502 (AI provider, platform site)
└── InternalError           -> 500
```

Every error carries `code` (stable), `message` (human), `traceId`, and `details?` (typed). The frontend's API client maps `code` → user-facing copy.

### 3.7 OpenAPI, SDK, and contract testing

- OpenAPI is generated on build; the file is checked in (`docs/api/openapi.yaml`) so PR diffs surface contract changes.
- The web SDK is generated from this YAML by `tools/codegen/openapi-to-client.ts`, producing typed fetchers + Zod parsers (no `any`).
- Pact-style contract tests run in CI: a recorded set of expected responses lives in `apps/web/test/contracts/`, and the API has a corresponding "verifier" suite. Breaking a contract fails the PR.

## 4. The orchestrator (`apps/orchestrator`)

The orchestrator is where correctness lives. It owns the run lifecycle, is the single writer to status fields, and turns user intent into worker tasks.

### 4.1 Domain model (recap)

A run is a tree:

```
JobRun
└── Stage[]            (one per platform, ordered by canonical sequence)
    ├── DiscoveryTask  (one per stage)
    └── ApplyTask[]    (per eligible job)
```

Stages run in series; tasks within a stage run with controlled concurrency (1 at a time for apply, batched for scoring).

### 4.2 Run state machine

```
              start                            
   pending ─────────► planning                 
                       │ stages seeded         
                       ▼                       
                   running ──────────► paused  
                       │  ▲              │     
                       │  └──── resume ──┘     
                       │                       
              all stages done                  
                       ▼                       
                     done                      
                                              
                                              
   any state ──── stop ──────► stopped         
   any state ──── unrecov ───► failed          
```

Per-stage:

```
   pending ─► discovering ─► applying ─► done
         │           │            │      ▲
         │           ▼            ▼      │
         │       skipped       skipped ──┘
         │       (no_account, etc.)
         ▼
       failed
```

Per-application (denormalized status set listed in Phase 3 §4.6):

```
   queued ─► submitting ─► submitted ─► viewed/shortlisted/rejected/interview/offer/withdrawn
        │              │
        │              └─► failed_*
        └─► skipped_*
```

State machine implementation: a hand-rolled, table-driven reducer in `packages/shared-events/src/state-machines/`. Each transition function is pure (`(state, event) → state | RejectedTransition`). The orchestrator wraps it in a PG transaction:

```
BEGIN;
  SELECT ... FOR UPDATE on the row;
  apply transition in TS;
  UPDATE the row;
  INSERT into run_events / application_events (transactional outbox);
COMMIT;
```

Outbox rows are then relayed to Redis Pub/Sub by a tiny `outbox-relay` worker. Reasoning: Pub/Sub is best-effort; PG is durable. The relay reconciles the two.

### 4.3 Single-writer rule and sharding

Only the orchestrator process writes to `job_runs.status`, `run_stages.status`, and `applications.status`. Workers report progress by inserting events; the orchestrator picks them up.

We shard orchestrator instances by `consistent_hash(user_id, num_replicas)`. Each replica owns a subset of users; only the owner replica issues commands and applies transitions for that user's runs. Ownership is leased via Redis with TTL and heartbeat. Failover is automatic: a missed heartbeat releases the lease, another replica picks up, and re-derives in-flight runs from PG.

### 4.4 The dispatcher

The dispatcher is the orchestrator's hot loop. Steady-state behavior:

1. Poll PG for runs in `running` owned by this replica, ordered by `started_at ASC`.
2. For each, find the active stage (lowest `ordinal` not in `done|skipped|failed`).
3. If the stage is `pending`: transition to `discovering`, enqueue a `discovery` BullMQ job.
4. If the stage is `discovering`: wait for the discovery task to finish (event-driven; not poll-driven).
5. If the stage is `applying`: enqueue up to `apply_concurrency=1` next pending `ApplyTask` for that stage. Skip jobs older than 5 days (freshness rule). Apply jobs in priority order: t5h → t12h → t24h → t5d.
6. When stage `applied_count >= target` or no eligible jobs remain → transition stage to `done`. Move to next stage.
7. When all stages are terminal → run `done`. Trigger analytics rollup.

Dispatcher work is event-driven where possible: BullMQ completion events trigger reductions instead of timers. A safety timer ticks every 30 seconds to handle missed events.

### 4.5 Pause / resume / stop semantics

- **Pause**: sets `runs.control = 'paused'`. The orchestrator stops dispatching new tasks for that run. **In-flight tasks complete** (we never abandon a half-submitted application). When the in-flight task finishes, the run transitions to `paused`. Workers respect a control check between atomic steps; if a step is interruptible (e.g., scrolling search results), they yield.
- **Resume**: sets `runs.control = 'run'`. The dispatcher resumes from the same place; nothing replays.
- **Stop**: sets `runs.control = 'stop'`. In-flight tasks complete, then the run transitions to `stopped`. There is no "soft stop" that abandons mid-application work.
- **Pause-on-incident**: a worker emitting `human-required` (CAPTCHA/OTP) auto-pauses the run if the user's mode is `assisted`; in `autonomous`, the application is `skipped_human_required` and the run continues.

### 4.6 Idempotency and exactly-once apply

The hard guarantee: **for any `(user_id, job_id)` pair, at most one `applications` row in a non-failed terminal state.**

Mechanisms:
- The `applications.idempotency_key = 'apply:{run_id}:{stage_id}:{job_id}'` is unique. Retries from BullMQ insert with `ON CONFLICT DO NOTHING` and treat conflict as "we already started this; observe and reconcile."
- A second guard: `UNIQUE(user_id, job_id)` partial index on `applications WHERE status NOT IN ('failed_*','skipped_*')`. We never apply twice.
- The worker's submit step writes the `applications` row to `submitted` only after the platform's submission UI confirms (network 200 + DOM signal). Failure before that point keeps it in `submitting`; the orchestrator's timeout reaper (10 minutes) inspects `submitting` rows, asks the worker for status, or marks them `failed_platform_error` and lets the next stage run continue.

### 4.7 Backpressure

The orchestrator does not blindly enqueue. It honors:
- **Per-user concurrency caps**: enforced via Redis semaphores (`lock:user-platform:{user_id}:{platform}` with TTL).
- **Per-platform global RPM**: a token bucket per platform key, e.g., LinkedIn: 30 actions/min globally to avoid being a noisy neighbor across users.
- **Worker pool size**: queue length above a threshold causes the dispatcher to slow down, not pile up.
- **AI cost ceiling**: if the user's daily AI budget is at 95%, the orchestrator switches to "fallback mode": skip cover-letter generation, use cached scores, skip resume tailoring. The dashboard surfaces this state.

### 4.8 Failure handling and retries

| Failure | Retry policy | Escalation |
| --- | --- | --- |
| Worker step timeout | 3× exponential backoff (10s, 30s, 90s) | Mark task `failed_platform_error` after attempts; alert if rate exceeds threshold |
| Selector drift | 1 retry on the same task with the next-most-specific selector; if both fail, mark `failed_selector_drift`, capture DOM snapshot, escalate to on-call | The adapter's version is bumped in a hotfix |
| AI provider 5xx | Fall through to next-tier provider via gateway; if all fail, queue scoring as `deferred` | Background reprocessor catches up |
| AI Zod-validation failure on output | 1 retry with stricter system prompt; on second failure, fall back to "human-needed" answer for that question | Logged in `ai_decisions` |
| BullMQ job stalled | Stalled detection at 30s; auto-recover up to 3× | After that, dead-letter queue + alert |
| PG deadlock | Auto-retry the transaction up to 3× with jitter | Surfaced to telemetry; query pattern review |

Every retry path is **idempotent** by design; nothing relies on "retry only on certain errors."

## 5. Internal service contracts

All inter-service calls are HTTP/JSON over mTLS within the cluster. Schemas in `packages/shared-types`. Authentication: short-lived JWT signed by the API gateway, scoped to `user_id` and capability set, embedded in `Authorization: Bearer ...`.

### 5.1 API → Orchestrator
- `POST /internal/runs` — create a run from a validated user request.
- `POST /internal/runs/{id}/control` — set `pause | resume | stop`.
- `GET /internal/runs/{id}` — read state; used for command UX confirmation.

### 5.2 Orchestrator → Workers (via BullMQ; not HTTP)

Queues:
- `q:platform.discovery` — payload `{run_id, stage_id, user_id, platform_key, filters, freshness_window}`.
- `q:platform.apply` — payload `{run_id, stage_id, application_id, user_id, platform_key, job_external_id, resume_version_id}`.
- `q:platform.session.refresh` — payload `{user_id, platform_key}`.

Each job has an idempotency key; each job's lifecycle (start, progress, complete, fail) writes events that the orchestrator consumes from `q:platform.events` (a single events queue we drain in the dispatcher). Why a separate events queue: keeps "command flow" and "result flow" independent and trivially observable.

### 5.3 Workers → AI service (HTTP)
- `POST /score-jobs` — batch of up to 16 listings → scored batch.
- `POST /answer-question` — one question + context → answer + sources + confidence.
- `POST /tailor-resume` — resume version id + job description → new version proposal (stored as draft).
- `POST /generate-cover-letter` — application context → cover letter text.
- `POST /review-profile` — profile snapshot → suggestions list.

### 5.4 AI service → Providers
Hidden behind `packages/ai-core/providers/`. Workers and orchestrator never address Anthropic/OpenAI directly.

### 5.5 Workers → Vault (via lease)
- `POST /vault/lease` — short-lived lease for `(user_id, platform_key)` returning a one-time use redemption token.
- `POST /vault/redeem` — the worker exchanges the token for the credential bundle, which is held only in memory for the duration of one login attempt.

## 6. The transactional outbox in detail

Two outbox tables augment the schema (added as part of M0 migrations):

```sql
CREATE TABLE outbox_events (
  id           BIGSERIAL PRIMARY KEY,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  topic        TEXT NOT NULL,            -- 'events:run:{run_id}','events:user:{user_id}'
  payload      JSONB NOT NULL,
  delivered_at TIMESTAMPTZ NULL
);
CREATE INDEX outbox_events_undelivered_idx ON outbox_events(id) WHERE delivered_at IS NULL;
```

The outbox-relay worker drains undelivered rows in commit order, publishes to Redis Pub/Sub, and stamps `delivered_at`. A failure to deliver does not lose events; they remain undelivered until the relay catches up. A monitoring rule alerts if the lag exceeds 30 seconds.

## 7. Configuration management

- `packages/shared-config` exports `loadConfig<TSchema>(schema)` that reads from environment, validates with Zod, and freezes the result. Apps call this at boot and crash-fast on misconfiguration.
- Secrets are never read from environment in production. The config loader resolves `${vault:apex/api/db_url}` references at boot via the Vault client.
- Feature flags are environment-driven for ops-controllable toggles (`ANTI_DETECTION_PROFILE`, `AI_TIER_ROUTING`), and DB-driven for product flags (per user, surfaced in `users.feature_flags` JSONB).

## 8. Logging, tracing, metrics

- **Logs**: Pino → stdout → Loki. Always include `traceId`, `spanId`, `userId` (when authenticated), `runId` (when present), `route` (when HTTP). Log levels: `debug` (dev only), `info`, `warn`, `error`. PII redaction: a deny-list of keys (`password`, `secret`, `phone`, `dob`, `address`, `cipher*`) plus an allow-list mode for `personal_info` reads, which logs only `{userId}` and writes a `security_events` row.
- **Traces**: OTel → Tempo. Spans wrap business boundaries; HTTP, DB, and queue operations are auto-instrumented; expensive AI calls have a `gen_ai.cost_usd` attribute.
- **Metrics**: Prometheus exposition at `/metrics` (internal port). Standard sets:
  - `http_server_request_duration_seconds{route,method,status}`
  - `bullmq_job_duration_seconds{queue,outcome}`
  - `bullmq_queue_depth{queue}`
  - `db_query_duration_seconds{op}`
  - `ai_call_duration_seconds{prompt_key,model,tier}`
  - `ai_cost_usd_total{user_id_hash,prompt_key}`
  - `applications_submitted_total{platform,status}`
  - `runs_active{state}`

## 9. Testing strategy

| Test type | Where | When | Tooling |
| --- | --- | --- | --- |
| Unit | Each module/package | On every commit | Vitest |
| Integration (DB) | `packages/db/test`, app modules with real PG | On every PR | Vitest + Testcontainers (PG, Redis) |
| Contract | API ↔ web | On every PR | Custom Pact-lite over Zod |
| Adapter (offline) | `packages/platform-adapters/<x>/test` against saved fixtures | On every PR | Playwright with `route` mocks |
| Adapter (canary) | Live, read-only, against real sites; nightly | Nightly | Playwright in CI; alert on drift |
| End-to-end | Full stack in `infra/compose/e2e.compose.yaml` | Nightly + on main | Playwright |
| AI eval | `tools/eval-harness` | On every change to prompts | Custom |
| Load | k6 against staging | Weekly | k6 |
| Chaos | toxiproxy + pumba | Pre-release | k6 + scripts |

## 10. The optimization service (profile + resume review)

This is a separate concern from "tailor a resume for this job"; it is the recurring pulse that suggests improvements.

Flow:

1. User opens **Profile Optimization** in the UI; the API records intent and queues `profile.review`.
2. AI service runs the `profile.review` prompt against the user's profile snapshot and recent platform-side renderings (when available via a non-mutating fetch through the worker).
3. Returns a list of suggestions, each shaped:
   ```ts
   { id, area: 'headline'|'summary'|'skills'|...,
     issue: string, expectedBenefit: string,
     suggestion: { current: string, proposed: string },
     confidence: 0..1 }
   ```
4. The API stores suggestions in `optimization_suggestions` (a small table, not partitioned).
5. The user reviews each in the UI; **no change is applied** without explicit `approve` per suggestion. Approve: writes the change to the appropriate domain row + an `audit_log` entry. Reject: marks dismissed; we feed dismissal back to the AI service as negative evidence.

Resume optimization follows the same "suggest then approve" pattern but through `resume_versions`: a tailored version is stored as `source = 'ai_tailored'` with `approved_at = NULL`. It only becomes the current version when the user approves; until then it can be previewed and diffed.

## 11. Data export and account deletion

Both are first-class endpoints, not afterthoughts.

- **Export** (`POST /me/export`): enqueues a job that builds a ZIP containing JSON snapshots of every user-owned table plus signed URLs to resume files. Email link with one-time-use, 24-hour TTL.
- **Delete** (`DELETE /me`): two-step: request, then confirm with MFA + email link. On confirm, soft-delete users.deleted_at; a daily reaper runs hard-delete after 30 days. Audit log retains a tombstone with non-PII fields.

## 12. Observability of business outcomes

Beyond infra metrics, we publish business KPIs as Prometheus counters/gauges:
- `business_applications_per_run{platform}`
- `business_apply_success_rate{platform}`
- `business_apply_skipped_human_required_total{platform}`
- `business_response_rate_24h{platform}` (gauge from rollups)
- `business_ai_cost_per_application{platform}`

These power the "Operations" tab of the analytics dashboard and feed alerts when a platform's success rate drops 25% week-over-week (likely selector drift or platform UX change).

## 13. Performance budget for the backend

| Path | p95 budget | Where the time goes |
| --- | --- | --- |
| `GET /api/v1/applications?limit=50` | 80 ms | PG (~30 ms) + serialization (~20 ms) + middleware (~30 ms) |
| `POST /api/v1/runs` | 200 ms | Validation + insert + enqueue |
| Orchestrator dispatch tick | 50 ms | PG read + Redis sema + enqueue |
| AI `score-jobs` (batch=8) | 800 ms | One model call; parsing; persistence |
| AI `answer-question` | 1500 ms | RAG (200 ms) + model (~1.0 s) + zod + persist |
| Worker `apply.task` end-to-end | 60 s typical | Bound by the platform's own UI; 90% of the time is the site, not us |

CPU profile targets:
- API: < 30% CPU at 200 RPS per replica.
- Orchestrator: < 15% CPU per shard at typical load.
- AI service: bottleneck is provider; CPU stays low.
- Worker: bottleneck is browser; CPU 50–70% per active context is normal.

## 14. Tradeoffs accepted

- **Centralized orchestrator over per-worker autonomy.** Slower to add features, but the single-writer rule eliminates an entire class of state-corruption bugs.
- **REST + OpenAPI over GraphQL.** Simpler caching, simpler audit, simpler client, at the cost of more endpoints. Fine.
- **HTTP between services over gRPC.** mTLS gives us auth/encryption; HTTP/JSON is debuggable in any browser. gRPC remains an option if a hot path needs it.
- **Outbox over a "real" event bus (NATS/Kafka).** PG-as-source-of-truth + tiny relay is enough at our scale and removes another moving part. We can introduce Kafka in M9 if cross-tenant analytics demands it.
- **NestJS over a thin Fastify app.** A bit more ceremony; the DI and module isolation pay back in maintainability.

## 15. What this phase deliberately does not decide

- Concrete prompt templates and Zod schemas for AI calls — Phase 7.
- Exact selectors and per-platform flow shapes — Phase 6.
- UI of the profile-optimization screens — Phase 5.
- Specific deployment topology (replicas, node pools, autoscaling) — Phase 9.
