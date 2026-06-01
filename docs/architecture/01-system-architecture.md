# Phase 1 — System Architecture

## 1. Purpose of this document

Define the runtime shape of APEX JOB AGENT: which processes exist, what they own, how they talk, where state lives, and where each non-functional requirement (speed, reliability, security, scalability, maintainability) is satisfied. Code-level details belong in later phases.

---

## 2. Logical components

The system has nine logical components. Each has one job; each can be deployed and scaled on its own.

### 2.1 Web client (`apps/web`)
React 18 single-page app. Talks only to the API gateway. Holds no secrets. Subscribes to the real-time channel for live updates of runs, applications, and analytics.

### 2.2 API gateway / BFF (`apps/api`)
NestJS service. The single entry point for the client. Owns:
- Authentication (session cookie + CSRF, WebAuthn + TOTP).
- Authorization (RBAC + permission scopes).
- Input validation (Zod).
- Read APIs (server-state for TanStack Query).
- Command APIs (start run, pause, resume, stop, approve resume change, etc.) — these enqueue work; they do not perform it.
- Real-time fan-out (Socket.IO server) reading from a Redis Pub/Sub channel produced by the orchestrator and workers.

### 2.3 Orchestrator (`apps/orchestrator`)
The brain of run lifecycle. Stateless process backed by PostgreSQL + Redis. Owns:
- The run state machine (see Phase 4 §3).
- Splitting a run into per-platform stages, each into per-job tasks.
- Enforcing the platform sequence in Multi-Platform mode.
- Applying the freshness ranking before tasks are dispatched.
- Pause / resume / stop transitions.
- Heartbeats and dead-worker recovery (orphaned tasks return to pending after a TTL).

The orchestrator is the only writer to `job_runs.status` and `applications.status`. Workers report progress; the orchestrator mutates state. This single-writer rule is what makes resumability tractable.

### 2.4 Automation worker (`apps/automation-worker`)
The hands. Pulls platform tasks from BullMQ, restores a persistent Playwright context for `(user_id, platform)`, performs discovery and application, and emits events. Stateless beyond the per-job in-memory step buffer; all durable state goes to PostgreSQL and object storage.

Key properties:
- One worker process can handle many users sequentially, but never two tasks for the same `(user, platform)` concurrently (enforced via Redis lock).
- Each worker has access to the credential vault through a short-lived, scoped lease (no long-lived secrets in worker memory).
- Each worker owns a browser pool sized by available memory; contexts evict on LRU.

### 2.5 AI service (`apps/ai-service`)
The reasoning layer. NestJS. Owns:
- LLM gateway with provider abstraction and tiered routing (Opus/Sonnet/Haiku-class).
- RAG pipeline against the user knowledge base (pgvector).
- Prompt registry (versioned).
- Output validation (Zod schema per prompt; reject + retry on shape failure).
- Cost ledger (token in/out, USD, per user, per feature).
- Decision audit writer.

Workers and the orchestrator call the AI service over an internal HTTP API. The AI service never calls back into them; the dependency graph is one-way.

### 2.6 Analytics service (`apps/analytics`)
Append-only event ingest plus rollup workers. Writes to `analytics_events` (hot) and to materialized views / continuous aggregates (warm). Serves the dashboard via the API gateway, never directly.

### 2.7 PostgreSQL (system of record)
PG 16 with extensions: `pgcrypto`, `pgvector`, `pg_partman`, `pg_trgm`, `uuid-ossp`. Holds users, profiles, credentials (ciphertext + KMS key references), resumes, jobs, runs, applications, Q&A memory, embeddings, AI decisions, audit log, analytics events.

### 2.8 Redis
Three logical roles, separated by DB index or key prefix:
- **Queues** (BullMQ): `q:platform-task`, `q:ai-call`, `q:notify`.
- **Locks & rate limits**: per-`(user, platform)` semaphores; per-platform global RPM ceilings.
- **Pub/Sub**: real-time event fan-out from orchestrator/workers to the API gateway.

### 2.9 Object storage (S3-compatible)
Resumes (current and historical versions), screenshots per application step, DOM snapshots for forensic replay, generated cover letters. All objects are referenced from PG by URI, not embedded.

---

## 3. Data plane vs control plane

A clean separation that pays for itself the first time something breaks.

| Plane | What it carries | Tech | Failure tolerance |
| --- | --- | --- | --- |
| **Control** | Commands (start/pause/stop), state transitions, configuration | PG, BullMQ delayed jobs | Must survive process restarts; durable. |
| **Data** | Live progress, screenshots, log lines, metrics | Redis Pub/Sub, object storage, OTel pipeline | Lossy is acceptable for the live UX; persisted copies live in PG/S3. |

The frontend's *live* feed is data-plane. The frontend's *truth* (history, counts) reads from PG via the API. If Redis Pub/Sub drops events, the truth is unaffected.

---

## 4. Communication patterns

### 4.1 Synchronous HTTP/JSON
- Client → API: REST under `/api/v1/...`. Idempotency keys on commands.
- API → AI service: internal HTTP. Same Zod contracts as the public API.
- API → Orchestrator: internal HTTP for command dispatch (small, frequent).

### 4.2 Asynchronous queues (BullMQ on Redis)
- Orchestrator → Workers: `q:platform-task` with payload `{run_id, stage_id, platform, user_id, idempotency_key}`.
- AI service internal: `q:ai-call` for non-blocking AI work (e.g., bulk relevance scoring).
- Notification dispatch: `q:notify` for email/push/web events.

Workers ack jobs only after the unit of work is durably committed to PG. Dead-letter queues are mandatory for every queue; they feed an alert and a human-reviewable inbox.

### 4.3 Pub/Sub
- Channel `events:run:{run_id}` for run-scoped progress events.
- Channel `events:user:{user_id}` for cross-run notifications (run started, paused, finished, application submitted).
- The API gateway subscribes per connected client and forwards filtered events over Socket.IO.

### 4.4 Event log (durable counterpart to pub/sub)
Every published event is also written to `application_events` or `run_events` rows. The UI's "replay" feature (scrub a run's timeline) reads these rows, not Pub/Sub.

---

## 5. End-to-end request path: "Start a multi-platform run"

This walks the system. Numbers correspond to the diagram described textually.

1. **Client** issues `POST /api/v1/runs` with `{mode: "multi", platforms: [...], targetPerPlatform: 20, threshold: 70, mode_a: true}` and a fresh idempotency key.
2. **API gateway** validates the body (Zod), checks RBAC + permission scopes (e.g., resume edit on/off per platform), persists `job_runs` row in `pending`, returns `202 Accepted` with the `run_id`.
3. **API** publishes a control message to the orchestrator queue.
4. **Orchestrator** transitions `pending → planning`, expands the run into stages (one per requested platform, in the canonical order), and per stage seeds a *discovery* task. State persists in PG inside one transaction.
5. **Worker** picks up the discovery task. Acquires the `(user, platform)` semaphore. Restores the persistent Playwright context. Logs in if the session is stale (using a vault lease that expires in 5 minutes). Searches per the user's preferences. Streams discovered listings into the AI service.
6. **AI service** scores each listing 0–100 against the user's profile, writes the score to `jobs.score`, writes a decision row to `ai_decisions`. Returns scored listings.
7. **Worker** filters by threshold and freshness tier, enqueues per-job *apply* tasks (still under the same stage), and reports `discovery_complete` to the orchestrator.
8. **Orchestrator** transitions the stage to `applying`. As workers complete each apply task, the orchestrator increments counters and emits run-scoped events.
9. **Worker** for each apply task: opens the listing, gates on quick-apply availability, fills the form, calls the AI service for each free-text question (RAG against the knowledge base, validated output, consistency-checked against `qa_memory`), uploads the chosen resume version, submits. Writes `applications` row, screenshots to S3, decisions to `ai_decisions`, events to `application_events`. Emits Pub/Sub.
10. **API gateway**, via Socket.IO, pushes the live timeline to the connected client.
11. **Orchestrator**, when stage applications meet `targetPerPlatform` or no eligible jobs remain, transitions the stage to `done` and starts the next platform stage.
12. **Run finishes** when all stages are `done` or `skipped`. Final analytics rollup runs. User gets a notification.

Pause is a control message that flips `runs.control = paused`; workers check it between atomic steps and yield. Resume flips it back; orchestrator re-dispatches the next pending task.

---

## 6. Concurrency model

The hard rule: **per `(user, platform)` we are sequential; everything else parallelizes.**

- **Across users**: fully parallel, bounded only by worker pool size.
- **Across platforms for one user**: sequential by spec (Multi-Platform mode runs in canonical order). Within Single Platform mode, only one platform is active.
- **Within a platform's apply phase**: sequential application submissions. Discovery and scoring can pipeline (worker scrolls, AI scores in batches) but submissions go one at a time to look human and avoid platform-side rate trips.
- **AI calls**: parallel across users; per-user concurrency is capped by the cost governor (Phase 7 §6).

Locks live in Redis with TTL safety nets:
- `lock:user-platform:{user_id}:{platform}` — semaphore=1, TTL=15 min, refreshed by worker heartbeat.
- `lock:apply:{user_id}:{platform}:{job_external_id}` — guarantees we never submit twice for the same listing even on retry storms.

---

## 7. State, durability, idempotency

State lives in three places, each with a strict ownership rule:

| State | Owner | Durability |
| --- | --- | --- |
| Identity, profile, credentials, resumes, runs, applications, AI decisions, audit | PostgreSQL | Synchronous commit; PITR; nightly logical + continuous WAL backup. |
| Queues, locks, ephemeral run progress, real-time fan-out | Redis | AOF + RDB; queues recoverable from BullMQ semantics; live channels are best-effort. |
| Resumes, screenshots, generated artifacts | Object storage | Server-side encryption; lifecycle rules; versioned bucket for resumes. |

Idempotency:
- Command APIs require an `Idempotency-Key` header; the API stores key→response for 24h.
- Each apply task carries a deterministic key `apply:{run_id}:{stage_id}:{job_id}` so retries are no-ops.
- Workers must finish "either submit *and* persist *and* ack, or none of the above" using a transactional outbox pattern: write the application row + outbox row in one PG tx, ack BullMQ only after PG commit, publish events from the outbox via a relay.

Recovery:
- A crashed worker leaves its Redis lock in place; the lock has a TTL plus a heartbeat. If the heartbeat stops, the lock auto-releases and the orchestrator returns the task to `pending`.
- A crashed orchestrator restarts and re-derives in-flight runs from PG; no work is lost because the queue is durable.

---

## 8. Performance budget

These are not aspirations; they are SLOs the system is designed against. They drive every later choice (DB indexes, Playwright tuning, AI tier routing).

| Operation | Target p95 | How achieved |
| --- | --- | --- |
| API read (dashboard tile) | < 120 ms | TanStack Query + PG index + warm rollups |
| API command (start run) | < 250 ms | Validate + insert + enqueue; AI/automation are async |
| Job relevance score per listing | < 800 ms | Sonnet/Haiku-tier model; batched 8–16 listings per call |
| Free-text Q&A answer | < 1.5 s | RAG top-k=5; Sonnet-tier; cached for repeat questions |
| Form fill per field | < 250 ms | Pre-warmed selectors + debounced typing |
| End-to-end one application | < 75 s | Mostly bounded by platform's own UI; we don't chase faster than safe |
| End-to-end discovery for one platform | < 90 s for 200 listings | Pipelined scoring |
| Real-time event delivery to UI | < 500 ms | Pub/Sub → Socket.IO direct |
| Run resume after restart | < 5 s | Orchestrator reads PG and re-dispatches |

Failure budget: 99.5% successful task completion within retry policy, measured monthly. Anti-detection trips (CAPTCHA/OTP) are not counted as failures; they are expected branches.

---

## 9. Scalability path

The system scales along three axes; each scales independently.

1. **Horizontal user scale**: more API replicas, more orchestrator replicas (sharded by `user_id` consistent hash), more AI workers. PG vertical-scales until ~50k active users; then read replicas + connection pool (PgBouncer) handle the load. Beyond that, partition the heaviest tables (`applications`, `analytics_events`, `ai_decisions`) by `user_id` hash.
2. **Browser-bound scale**: automation workers live in a dedicated node pool with high RAM and CPU. Each pod runs N Playwright contexts (N tuned by memory headroom, default 4). Add pods, not contexts per pod, past the elbow.
3. **AI-bound scale**: the LLM gateway is the bottleneck and the cost center. We control it with (a) tier routing by task class, (b) batch APIs where supported, (c) prompt-cache for stable system prompts, (d) per-user daily token budget.

What does not scale by adding hardware: a single platform's tolerance for one account's traffic. We do not solve that; we respect it. If a user wants higher throughput, they connect a second account on a different platform — never two simultaneous sessions on the same platform under the same identity.

---

## 10. Reliability & failure modes

| Failure | Detection | Containment | Recovery |
| --- | --- | --- | --- |
| Worker crash | Missed heartbeat | Lock TTL releases; task returns to queue | Another worker picks up; idempotency key prevents duplicate apply |
| AI provider outage | Circuit breaker opens | Fall through to next-tier provider; if all fail, mark scoring `deferred` | Background reprocessor catches up when provider recovers |
| Platform site down | HTTP 5xx / timeout | Retry with backoff; if persistent, mark stage `paused`, notify | Orchestrator retries on schedule |
| OTP / CAPTCHA encountered | Worker emits `human-required` | Mode-A pauses run, notifies user; Mode-B skips with reason | User completes; worker resumes by visiting same URL |
| Selector drift after platform redesign | Per-step assertion fails | Worker emits a `selector-drift` incident with screenshot + DOM snapshot | Adapter version is pinned per-platform; we ship a hotfix and the orchestrator replays pending tasks |
| PG primary failure | Health check | Failover replica promotes (managed PG) or PgBouncer redirects | < 60s RTO, < 1 min RPO |
| Redis failure | Health check | Sentinel/cluster failover; queues persist on AOF | Workers reconnect; orchestrator re-derives |
| KMS unreachable | Vault client error | Block writes that need new keys; allow reads with cached DEKs | Recover when KMS returns; alert on duration |

Every category above has a runbook entry under `docs/runbooks/` (added in M9).

---

## 11. Security touchpoints in this layer

Detailed in Phase 8; named here so readers can map the layer to its protections.

- mTLS between internal services in production (service mesh: Istio or Linkerd).
- All inter-service calls carry a signed, short-lived JWT minted by the API gateway from the user's session.
- Workers receive **scoped credential leases**, never raw credentials. The lease is a one-time-use, 5-minute token redeemed at the vault for the specific platform login at the moment it is needed.
- Object storage URLs returned to the client are presigned, short-TTL, and scoped to a single object.
- Browser contexts are isolated by Linux user namespace; cookies from user A cannot land in user B's context.

---

## 12. Tradeoffs explicitly accepted

- **Modular monolith over microservices early.** Faster to build, easier to reason about, slightly harder to scale a single hot component independently. Boundaries in code make the future split mechanical.
- **Single primary DB.** Simpler operations, real foreign keys, transactional Q&A audit. We accept the eventual need to partition large tables; the schema is designed for it (Phase 3 §7).
- **Sequential applications per platform.** Slower than naive parallelism, but it is the only way to look human and to keep the user's account safe. We make up for it with discovery/scoring pipelining and multi-user parallelism.
- **Self-hosted auth.** More code than off-the-shelf SaaS, but it removes a third-party dependency from the most sensitive path and lets us bind sessions to the credential vault cleanly.
- **Two AI tiers from day one.** A small amount of routing complexity now buys 5–10× cost savings on routine Q&A. Worth it.
- **No browser farm SaaS.** Browserless / Browserbase are tempting; we reject for cost and isolation control. Revisit at M9 if ops burden warrants.

---

## 13. What this phase deliberately does not decide

- Specific selectors per platform — Phase 6.
- Specific prompts and Zod schemas — Phase 7.
- Specific table columns — Phase 3.
- Specific UI screens — Phase 5.
- Specific milestones — Phase 10.

Each of those depends on the shape established here, and each gets its own phase below.
