# Audit Step 1 — Architecture Validation

This document audits the existing architecture against six axes — scalability, security, reliability, performance, extensibility, maintainability — and lists every concrete weakness found on re-read. Each finding follows the same shape:

- **Issue** — what is wrong, with a pointer to the source document.
- **Impact** — what breaks (or what risk crystallizes) if we do not fix it.
- **Fix** — the smallest, most surgical change that resolves it.
- **Why superior** — why this fix beats alternatives we considered.

Findings are grouped by the layer they target. Severity classes:

- **S1 — Blocker.** Will cause data loss, security breach, or large user-visible outage if shipped as-is.
- **S2 — Material.** Will degrade reliability, performance, or maintainability under realistic load.
- **S3 — Refinement.** Improves correctness, observability, or future-proofing but not load-bearing.

---

## A. Database & schema (Phase 3)

### A1 — `applications` uniqueness blocks legitimate retries (S1)

- **Issue.** Phase 3 §4.6 declares `UNIQUE (user_id, job_id)` as a hard constraint. Phase 4 §4.6 separately declares a partial unique index `WHERE status NOT IN ('failed_*','skipped_*')`. The two contradict.
- **Impact.** A `failed_platform_error` row leaves a row in the table; a future retry attempt on the same `(user, job)` violates the hard constraint and the application is permanently un-retryable. Worse, the contradiction means whichever migration runs second in M0 will either fail or silently mask the other.
- **Fix.** Replace the hard constraint with a partial unique index, exactly as Phase 4 specified:
  ```sql
  CREATE UNIQUE INDEX applications_user_job_active_idx
    ON applications(user_id, job_id)
    WHERE status NOT IN (
      'failed_selector_drift','failed_platform_error',
      'skipped_human_required','skipped_low_score','skipped_stale','duplicate'
    );
  ```
  Also keep the `idempotency_key` unique constraint as a second guard.
- **Why superior.** A partial index lets us retry after transient failures while still preventing duplicate live applications. Alternatives — a soft-deleted "failed" row, or moving failed rows to a separate table — bloat the schema and complicate audit queries. The partial index is one line and keeps the audit trail intact.

### A2 — `embeddings.vector` is fixed-dimension (S2)

- **Issue.** Phase 3 §4.2 declares `vector vector(1024)`. Phase 7 §3 lists `voyage-2-large` (1024) and `text-embedding-3-large` (3072) as alternatives.
- **Impact.** A model swap requires schema migration of a billion-row table; in practice, it locks us into 1024-dim forever, even when 3072-dim is measurably better for our domain.
- **Fix.** Split into per-dimension sibling tables behind a view:
  ```sql
  CREATE TABLE embeddings_1024 (... vector vector(1024) NOT NULL, ...);
  CREATE TABLE embeddings_3072 (... vector vector(3072) NOT NULL, ...);
  CREATE VIEW embeddings AS
    SELECT ..., 1024 AS dim, vector::vector(1024) AS v FROM embeddings_1024
    UNION ALL
    SELECT ..., 3072 AS dim, vector::vector(3072) AS v FROM embeddings_3072;
  ```
  Each per-dim table has its own IVFFlat index. The application addresses sibling tables by `(owner_kind, model)`.
- **Why superior.** PostgreSQL cannot index a polymorphic-dim column; pgvector's index requires fixed dim. Sibling tables avoid that entirely. The view gives a single reading surface for repository code that doesn't care about dim. Alternative — JSONB blobs with manual cosine in app — gives up indexable ANN, which is a non-starter at our scale.

### A3 — Missing `outbox_events` in canonical schema (S2)

- **Issue.** Phase 4 §6 introduces a transactional outbox that is the durable counterpart to Redis Pub/Sub. Phase 3 §4 does not define the table. New engineers reading the schema cannot see how durable events are produced.
- **Impact.** The outbox-relay worker has no schema to point at; M0 risks shipping it as an undocumented side-channel.
- **Fix.** Add to the canonical schema:
  ```sql
  CREATE TABLE outbox_events (
    id           BIGSERIAL PRIMARY KEY,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    aggregate    TEXT NOT NULL,           -- 'run','application','user','security'
    aggregate_id UUID NOT NULL,
    topic        TEXT NOT NULL,           -- 'events:run:{id}','events:user:{id}'
    payload      JSONB NOT NULL,
    delivered_at TIMESTAMPTZ NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT
  );
  CREATE INDEX outbox_events_undelivered_idx
    ON outbox_events(id) WHERE delivered_at IS NULL;
  ```
- **Why superior.** Transactional outbox is the cheapest way to get exactly-once semantics for events that must mirror DB writes. Alternatives — Debezium CDC, Kafka — require infra we do not run at this scale and complicate self-host.

### A4 — Missing `idempotency_keys` table (S2)

- **Issue.** Phase 4 §3.5 states "Redis 24h with PG backstop for >24h dedupe" but Phase 3 has no backing table.
- **Impact.** A Redis flush, or a >24h replay (e.g., a delayed retry after an extended outage), causes duplicate command execution.
- **Fix.**
  ```sql
  CREATE TABLE idempotency_keys (
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key              TEXT NOT NULL,
    method           TEXT NOT NULL,
    path             TEXT NOT NULL,
    request_hash     BYTEA NOT NULL,        -- SHA-256(canonical body)
    response_status  INTEGER NOT NULL,
    response_envelope JSONB NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at       TIMESTAMPTZ NOT NULL,  -- 7 days
    PRIMARY KEY (user_id, key)
  );
  CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys(expires_at);
  ```
  Redis remains the hot cache (24h, sub-ms read); PG is the cold backstop (7d, ms read). A nightly reaper deletes expired rows.
- **Why superior.** Two-tier storage gives 99.9% of reads at Redis speed and a durable ground truth for the rest. Alternative — Redis-only — is fast but loses idempotency on `FLUSHALL` or AOF corruption. Alternative — PG-only — is correct but slow on the hot path.

### A5 — `qa_memory.application_id` cyclic FK is unhealthy (S3)

- **Issue.** Phase 3 §4.2 adds `qa_memory.application_id` later via `ALTER TABLE` because the FK to `applications` would be cyclic at create time. The cyclic dependency makes seed and test setup awkward.
- **Impact.** Test fixtures must order inserts carefully; a Prisma-generated migration runs `ALTER TABLE` after both tables exist.
- **Fix.** Drop the FK; keep `application_id UUID NULL` as an opaque reference. Joins against `applications` proceed normally; the FK was buying lifecycle cascade, but Q&A memory should *survive* an application's deletion (we want the answer reused next time).
- **Why superior.** The FK promised a guarantee (no orphans) that we don't actually want — the desired behavior is exactly orphans-on-delete. Removing the FK aligns the schema with the lifecycle.

### A6 — `personal_info` PII columns lack key-rotation columns (S3)

- **Issue.** Each `*_enc` column is wrapped with the user DEK, but the schema doesn't carry the wrapping-version. On DEK rotation we cannot tell which rows are rewrapped.
- **Impact.** Background re-encryption jobs can't be incremental and resumable.
- **Fix.** Add `personal_info_dek_version SMALLINT NOT NULL DEFAULT 1` and analogous columns on every table holding `*_enc`. Re-encryption job iterates rows where version < current.
- **Why superior.** A two-byte column is cheap and makes rotation a trivial background job. Alternative — re-encrypt all rows in a single transaction — locks the table for hours.

### A7 — Partition strategy doesn't cover `application_questions` and `application_files` (S3)

- **Issue.** Phase 3 §7 partitions `analytics_events`, `application_events`, `run_events`, `ai_decisions`. `application_questions` and `application_files` grow at the same shape (one row per Q or per file × applications) and become large.
- **Impact.** At scale (100k apps/day), `application_questions` adds ~500k rows/day. Unpartitioned, it crosses 100M rows in 7 months. Indexes still work, but maintenance (REINDEX, vacuum) becomes painful.
- **Fix.** Add monthly partitioning by `created_at` to both tables once they cross 10M rows; the schema is partition-ready (partition key already in PK).
- **Why superior.** Partition-now-or-later is the question; partition-later when the cost of partitioning is small (M2/M3 timeframe) is right. Pre-partitioning at M0 adds complexity without payoff.

### A8 — `audit_log` hash-chain is global, not per-tenant (S3)

- **Issue.** Phase 3 §5 describes a single hash chain across all rows. M9 introduces multi-tenancy. A tenant cannot independently verify their portion of the chain without reading every other tenant's rows.
- **Impact.** Tenant-isolated verification, attestation, and export require a cross-tenant view, defeating the multi-tenant promise.
- **Fix.** Per-tenant chain head: add `tenant_id UUID NOT NULL`, change the trigger to compute `hash = SHA-256(prev_hash_for_tenant || canonical(row))`. A `audit_chain_heads` table holds the current head per tenant. Verification reads only that tenant's rows.
- **Why superior.** Aligns the audit model with the tenancy model. Alternative — keep one global chain — leaks ordering metadata across tenants.

---

## B. Backend & orchestration (Phases 1, 4)

### B1 — Cost governor is not atomic (S1)

- **Issue.** Phase 7 §7 specifies a daily ceiling per user but does not describe how concurrent AI calls reserve budget. A naive read-then-decide approach lets two parallel calls both pass at 99% budget.
- **Impact.** A bursty user can overshoot the daily ceiling by an integer multiple of their concurrency. At 10 concurrent calls, a $0.50/day ceiling can become $5.
- **Fix.** Atomic reserve in the same statement as the decision:
  ```sql
  WITH reserved AS (
    UPDATE ai_cost_ledger
       SET cost_usd = cost_usd + $estimated_cost,
           tokens_in = tokens_in + $estimated_in,
           tokens_out = tokens_out + $estimated_out
     WHERE user_id = $u AND day = $d
       AND cost_usd + $estimated_cost <= $ceiling
     RETURNING cost_usd, $estimated_cost
  )
  SELECT * FROM reserved;
  ```
  If the row isn't returned, the call is rejected (or downgraded). After the call, we adjust to actuals.
- **Why superior.** Single statement, no read-then-write race. Alternative — application-level mutex — adds a hot lock and doesn't survive multi-replica AI service.

### B2 — Single-writer orchestrator: hot row contention on `job_runs` (S2)

- **Issue.** Phase 4 §4 dispatches by `SELECT ... FOR UPDATE` on the run's row, then enqueues. With multiple stages and tasks, the same run row is locked frequently.
- **Impact.** At high run concurrency per user (rare today, common at M9 multi-tenant), the dispatcher's tick latency spikes.
- **Fix.** Use `SELECT ... FOR UPDATE SKIP LOCKED` for stage-level dispatch and limit `FOR UPDATE` on `job_runs` to true status transitions (start/pause/resume/stop). Most tick work reads-only and updates `run_stages.applied_count` via `UPDATE ... RETURNING` without blocking the run row.
- **Why superior.** `SKIP LOCKED` is the canonical PG pattern for queue-style processing; it eliminates head-of-line blocking on hot rows.

### B3 — Socket.IO multi-replica needs Redis adapter (S1)

- **Issue.** Phase 9 §4 lists 3 API replicas. Socket.IO without `socket.io-redis-adapter` keeps each replica's connections in isolation. A Pub/Sub event arrives on one replica; clients on the other two never see it.
- **Impact.** Real-time UX silently fails for ~⅔ of users on any given event. Reproduces only under multi-replica deployment, which staging exercises but local dev does not.
- **Fix.** Add `@socket.io/redis-adapter` to `apps/api`; wire it into the Socket.IO server initialization in `packages/realtime`. Document Redis pub/sub channel naming so the adapter doesn't collide with our own.
- **Why superior.** Native, official adapter; one config line; works with our existing Redis cluster. Alternative — sticky sessions — works in browsers but breaks reconnect across rolling restarts.

### B4 — Orchestrator shard ownership lacks fencing tokens (S2)

- **Issue.** Phase 4 §4.3 leases ownership via Redis with TTL + heartbeat. Without a fencing token, a slow-GC pause on the old leader followed by a write after the new leader takes over produces a split-brain write.
- **Impact.** Two orchestrator replicas could both transition the same run, violating the single-writer rule.
- **Fix.** Issue a monotonically increasing fencing token with each lease (`INCR lock:user:{user_id}:fence`). Every state-mutating SQL statement includes `WHERE lease_fence < $token`; the row carries `lease_fence` so a stale leader's update affects 0 rows.
- **Why superior.** This is the standard fix for distributed-lock false-positives (Kleppmann's well-known critique of TTL-only locks). It costs one column and one extra `WHERE` clause.

### B5 — `application.idempotency_key` doesn't cover non-`run` apply paths (S3)

- **Issue.** The key is `apply:{run_id}:{stage_id}:{job_id}`. Manual one-off apply ("Apply this single job") doesn't have a run.
- **Impact.** Manual applies can duplicate if the user double-clicks during slow network.
- **Fix.** Make `run_id` nullable in the key shape; use `apply:manual:{user_id}:{job_id}` for manual paths. Update the partial unique index from A1 to handle both shapes.
- **Why superior.** Clear, consistent, no protocol bifurcation.

### B6 — No backpressure to clients on rate-limit-near events (S3)

- **Issue.** The token bucket is server-side; the client gets a `429` only after exhaustion.
- **Impact.** Bursty UI patterns (e.g., rapid filter typing on Job Stream) can hit the ceiling unexpectedly.
- **Fix.** Send `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` headers per the IETF draft; the API SDK exposes them; the UI throttles when remaining < 10%.
- **Why superior.** Standard, automatic, and improves both UX and server load.

### B7 — Outbox relay must guarantee per-aggregate ordering (S2)

- **Issue.** Phase 4 §6 doesn't specify ordering. Multiple relay replicas can deliver out of order on the same aggregate.
- **Impact.** UI sees `submitted` before `filling`. The `since` cursor still works, but transient UI glitches occur.
- **Fix.** Partition the relay by `aggregate_id` hash; each partition has a single owner; events for one aggregate are delivered in monotonic id order.
- **Why superior.** Per-aggregate FIFO is the only guarantee the UI actually needs; cross-aggregate order is not required.

### B8 — Reaper for `submitting` rows is described but not fully specified (S3)

- **Issue.** Phase 4 §4.6 mentions a 10-minute reaper. The criteria for "ask the worker for status" vs "fail" is hand-waved.
- **Impact.** Edge cases (worker crashed mid-form-submit, platform 5xx after click) take the wrong path.
- **Fix.** Reaper rule: row in `submitting` for ≥ 10 minutes with no `application_events` in the last 5 minutes → mark `failed_platform_error` with reason `reaper:no_progress`. If events exist but no `submitted`, leave it for another tick. Combined with the unique partial index from A1, this is safe.
- **Why superior.** Activity-based criterion catches "stuck mid-form" without aborting "slow-but-progressing" submissions.

---

## C. Automation engine (Phase 6)

### C1 — Job dedupe across platforms is missing (S2)

- **Issue.** A single posting on LinkedIn + Naukri + Indeed yields three `jobs` rows and three potential applications.
- **Impact.** Wasted applications; user appears spammy to the employer; AI cost paid 3×.
- **Fix.** Compute a canonical key: `lower_normalize(employer) || lower_normalize(title) || coarse_location_bucket`. Add:
  ```sql
  CREATE TABLE job_canonical_keys (
    canonical_key TEXT PRIMARY KEY,
    representative_job_id UUID NOT NULL REFERENCES jobs(id),
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ```
  And on `jobs`: `canonical_key TEXT NOT NULL` with FK to the canonical table. Orchestrator filters apply tasks: skip if a sibling job for the same canonical key has already produced a non-failed application for the user (= "already applied").
- **Why superior.** Cheap (one VARCHAR + index), reversible (we can resurface variants per-platform if signals diverge), and matches user mental model ("I applied to that already").

### C2 — Browser fingerprint never rotates after compromise heuristic (S2)

- **Issue.** Phase 6 §6.1 sets a stable per-user device profile and explicitly does not rotate. There's no escape valve when a platform starts CAPTCHA-walling that fingerprint.
- **Impact.** A "stuck" account state — every action triggers CAPTCHA — has no path out short of user manual intervention.
- **Fix.** Compromise-heuristic rotation: when `security_events` of kind `captcha.encountered` for `(user, platform)` exceed 3× baseline over the last 24 hours **and** `apply_success_rate` for that pair < 25%, the system queues a `fingerprint.refresh` task that:
  1. Persists a new device profile (different but still plausible).
  2. Marks the existing session as `health = 'stale'`, forcing re-login on next use.
  3. Notifies the user with a "We refreshed the device profile for X" log entry.
- **Why superior.** Rotates only when there's evidence — not on a schedule, which would itself look suspicious. Bounded by user notification so it's never silent.

### C3 — Paste-vs-type detection by platforms is unaddressed (S3)

- **Issue.** Phase 6 §6.3 describes character-by-character keystrokes but doesn't say *when* to type vs paste. Some platforms (LinkedIn, Wellfound) treat paste of a 2,000-char cover letter as a flag.
- **Impact.** False positives on suspicious-input heuristics.
- **Fix.** Adapter declares `pasteThreshold` per field (default: type if ≤ 200 chars, paste-then-edit-tail if > 200). Long fields are pasted then a small character is typed-then-deleted at the end to leave a "real key event" trace.
- **Why superior.** Realistic — humans do paste long text — without looking like a script.

### C4 — Per-user IP reputation tracking absent (S3)

- **Issue.** Phase 6 doesn't record which user's IP has had a recent CAPTCHA. Two users behind the same NAT can pile-on each other.
- **Impact.** Self-hosted multi-user setups are at risk.
- **Fix.** `ip_reputation_events` table with `(ip_inet, platform, event_kind, occurred_at)`. Worker pre-flight consults: if same `ip_inet` had ≥ 2 CAPTCHAs on this platform in last 30 minutes, delay this user's run by 15 minutes.
- **Why superior.** Cooperative throttling at the network identity (which platforms see) rather than per-user identity (which they don't).

### C5 — Adapter version drift in flight (S2)

- **Issue.** Phase 6 §14 pins adapter versions per `applications` row but doesn't define behavior when a worker pod with `v0.2` picks up a task enqueued under `v0.1`.
- **Impact.** Selectors mismatch silently; flaky failures attributed to the platform.
- **Fix.** Task payload includes `adapter_version_required`. Worker refuses to execute if its adapter version differs (returns the task to the queue). Helm rollouts use a coordinated upgrade: pause the dispatcher → drain workers → roll workers → roll dispatcher → unpause.
- **Why superior.** Explicit version contract on the task; workers self-select; rollouts are coordinated rather than racing.

### C6 — External ATS handoffs (Workday/Greenhouse/Lever) lack a stub adapter framework (S3)

- **Issue.** Phase 6 §14 punts to M9. Until then, "skipped_external_ats" is the outcome — but the adapter has no way to *recognize* which ATS so we can't even surface "use the Workday submit page" to the user.
- **Impact.** A meaningful share of Glassdoor / LinkedIn jobs are unreachable with no diagnostic.
- **Fix.** Lightweight `ats-detector/` shared module: detects Workday, Greenhouse, Lever, SmartRecruiters, Ashby by URL pattern + DOM signature. The skip reason becomes `skipped_external_ats:workday` etc. The user's UI shows the detected ATS and a "Open job in tab" button.
- **Why superior.** Cheap to implement, sets up M9 ATS adapters with telemetry already in place, and provides immediate UX value.

### C7 — Worker memory pressure has no first-class governor (S2)

- **Issue.** Phase 1 §9 sizes workers at 1 GiB headroom per context but provides no enforcement.
- **Impact.** A single pathological page (huge SPA, leaky video) can balloon a context's RSS to 2+ GiB; the worker OOMs and takes its other contexts down.
- **Fix.** Per-context memory budget enforced by Chromium's `--memory-pressure-off` not used; instead, the worker reads `/sys/fs/cgroup/memory.current` per context (via `CRIU` or simply Playwright's `/process` listing) and aborts a context that exceeds 1.5 GiB with `step.failed:reason=memory_pressure`. The pool drops the context and creates a fresh one for the next task.
- **Why superior.** Stops bad-citizen pages without coupling worker pod lifetime to one context's leak.

---

## D. AI engine (Phase 7)

### D1 — `captcha.classify` and `qa.normalize` cost not metered (S2)

- **Issue.** Phase 7 §2/§7 routes the two small classifiers through the AI service but Phase 7 §7 doesn't mention them in the cost ledger.
- **Impact.** A user with high CAPTCHA frequency or many novel questions can incur uncapped classifier cost outside their daily budget.
- **Fix.** Every gateway call (regardless of tier) decrements the ledger. Classifier calls are cheap (~$0.0002) but accounted. The governor's daily ceiling and burst bucket apply uniformly.
- **Why superior.** Single cost model; no exception classes; predictable bills for users.

### D2 — IVFFlat index is the wrong choice for evolving Q&A memory (S2)

- **Issue.** Phase 3 §4.2 picks IVFFlat. Phase 7 §6.3 acknowledges "we re-index quarterly or after a 30% row-count delta." For `qa_memory` and `embeddings` for `frequent_answers`, churn is much higher than that.
- **Impact.** Recall degrades on the most-edited corpus (Q&A memory), exactly where consistency matters most.
- **Fix.** Use **HNSW** for `qa_memory` and `frequent_answers` embeddings (incremental, no re-index needed). Keep IVFFlat for slow-churn corpora (job descriptions, projects). pgvector ≥ 0.5 supports both.
- **Why superior.** HNSW handles continuous insert/update without recall collapse. The cost — ~2× index build time, ~30% more storage — is irrelevant at our scale.

### D3 — Prompt-injection defense is incomplete for multi-step apply forms (S2)

- **Issue.** Phase 7 §15 wraps "untrusted text" in `<UNTRUSTED>` blocks for `app.answer`. For multi-step apply, a malicious job posting can inject instructions that affect later questions in the same application (because `qa_memory` carries forward).
- **Impact.** A poisoned `qa_memory` entry persists across applications.
- **Fix.** AI-generated answers from a posting flagged as `prompt_injection_suspected = true` (a small classifier on the job description) do **not** auto-write to `qa_memory`. The user's review explicitly approves before promotion.
- **Why superior.** Quarantines memory writes when there's evidence of attempted injection, without slowing the happy path.

### D4 — Provider rate-limit handling is hand-waved (S3)

- **Issue.** Phase 7 §16 mentions "respected via the provider adapter's response-headers parser" but doesn't specify the algorithm.
- **Impact.** A provider 429 storm degrades the whole AI service for all users.
- **Fix.** Per-provider token bucket fed by the response headers (`anthropic-ratelimit-*`, `x-ratelimit-*`); when remaining drops below 20%, the gateway fences out new calls of that tier (queues them) for a window proportional to the reset header. Pre-emptive backoff, not reactive.
- **Why superior.** Pre-emptive avoids the thundering-herd that follows reactive 429.

### D5 — Score calibration is not quarantined per cohort (S3)

- **Issue.** Phase 7 §17 calibrates by joining `applications.ai_score` with downstream outcomes globally.
- **Impact.** New geographies / new role types skew an existing user's calibration. A senior backend engineer's scoring drifts because junior interns join the platform.
- **Fix.** Calibrate per cohort defined by `(role_family, seniority, geography)`; default to global until cohort has ≥ 200 outcomes. The user's cohort is inferred from their preferences and can be overridden.
- **Why superior.** Calibration that is meaningful for the user, not for the population mean.

### D6 — `resume.tailor` operates on the entire resume, not the relevant section (S3)

- **Issue.** Phase 7 §13 takes the basis `resume_versions.parsed`. For 2-page resumes that's tractable; for 4+ page resumes (consultants, senior engineers) it bloats the prompt.
- **Impact.** Cost ≈ doubles on long resumes; quality not improved.
- **Fix.** Pre-filter sections by relevance (cosine match between section embedding and JD embedding). Only top-K relevant sections enter the prompt. Patch ops only target those sections; others pass through untouched.
- **Why superior.** Cheaper, faster, and produces a tighter diff for the user to review.

### D7 — Locked frequent answers can drift from canonical when the user edits manually (S3)

- **Issue.** Phase 7 §9 says locked answers are never rewritten by AI. But a manual edit changes the answer; downstream embeddings are stale until a re-embed runs.
- **Impact.** Lookup may match the old phrasing.
- **Fix.** A trigger on `frequent_answers` UPDATE writes a row to `embedding_refresh_queue`. The scheduler service drains the queue.
- **Why superior.** Eventual consistency, observable, doesn't block the write.

---

## E. Frontend (Phase 5)

### E1 — Real-time + TanStack Query reconciliation under route change (S3)

- **Issue.** Phase 5 §6 patches caches via `setQueryData` on Socket.IO events. If the user navigates *during* a patch arrival and the destination route uses a different `queryKey` shape, the patch lands on a stale slot.
- **Impact.** Occasional ghost rows or missing updates after navigation.
- **Fix.** Centralize patch routing in a single `realtime → cache` reducer that knows all `queryKey` shapes; on route change, the reducer reads the active routes' query keys from the router state and patches only matching caches. Buffer events for 200 ms across navigation.
- **Why superior.** Eliminates entire class of "I navigated and then it didn't update" bugs.

### E2 — Forms autosave to IndexedDB has no clearing strategy on logout (S2)

- **Issue.** Phase 5 §10 mentions IndexedDB autosave for long forms (profile). Phase 8 wipes session in-memory state on logout but Phase 5 doesn't say IndexedDB is cleared.
- **Impact.** A shared device retains the previous user's profile draft.
- **Fix.** Logout flow clears IndexedDB stores prefixed `apex.draft.*`. Encrypt drafts at rest with a key derived from the session secret so a stolen device cannot read drafts even before clearing runs.
- **Why superior.** Defense in depth; addresses the shared-device threat that the rest of the security model addresses for backend.

### E3 — Lighthouse budget enforcement on PRs without a baseline reset (S3)

- **Issue.** Lighthouse CI compares against the previous run. A regression that happens incrementally never trips the alarm.
- **Impact.** Death by a thousand cuts on bundle size and INP.
- **Fix.** Baseline pinning: every release tag freezes a baseline; PRs are compared against the baseline, not the previous PR.
- **Why superior.** Prevents cumulative drift.

### E4 — R3F memory leak risk on route changes is not addressed (S3)

- **Issue.** Phase 5 §12 lazy-loads R3F but says nothing about disposing scenes on unmount.
- **Impact.** Returning to Command Center repeatedly grows memory.
- **Fix.** A `useDisposableScene` hook that wraps every R3F mount and walks the scene graph calling `geometry.dispose()`, `material.dispose()`, `texture.dispose()` on unmount. Tested via Playwright with a memory-heap check.
- **Why superior.** Three.js leaks are notorious; explicit dispose is the only fix that survives.

---

## F. Security (Phase 8)

### F1 — Vault dev profile in self-host is unsafe for production (S1)

- **Issue.** Phase 9 §13.2 says "single-tenant cluster" but Phase 8 dev profile is "Vault dev mode" which is widely documented as not for production.
- **Impact.** A power user running `selfhost.compose.yaml` thinks they're protected; they aren't (Vault dev has plaintext keys on disk).
- **Fix.** Self-host gets a *production-mode* Vault with file storage, **auto-unseal via age** (passphrase-protected unseal key file) and an explicit operator-managed unseal key rotation. The dev profile remains for the local-dev compose only and is clearly labeled "DEV".
- **Why superior.** Self-host customers get real Vault semantics; they only sacrifice HA, which is acceptable for single-node.

### F2 — DEK kept in API process memory is not multi-replica safe (S2)

- **Issue.** Phase 4 §3.3 holds DEKs in a `Map<sessionId, DEK>` per API process. Multi-replica means a request lands on a replica that has never seen this session and must unwrap on demand.
- **Impact.** Functionally correct (each replica unwraps lazily) but means DEKs are present in *every* replica that handles requests for the user. Memory blast radius is higher.
- **Fix.** Restrict DEK presence: only the **edge** replica handling a given session holds it. Sticky session by session-id hash to a specific replica via consistent hashing in the ingress; failover unwraps on demand and tombstones the prior replica's cache via Pub/Sub.
- **Why superior.** Smallest reasonable blast radius; failover is automatic.

### F3 — Audit log retention vs GDPR right-to-erasure (S2)

- **Issue.** Phase 8 §19 retains audit log for 7 years. GDPR/DPDP `right-to-erasure` requests can include audit metadata.
- **Impact.** Retention vs erasure is a real conflict that needs an explicit policy.
- **Fix.** Audit retention covers **non-PII metadata only** by default. The fields that carry user identity in `audit_log.metadata` are stored as `user_id` (UUID) without PII; on erasure, we destroy the user's DEK (which makes encrypted PII unreadable) but **keep the audit row** with the UUID. The UUID alone is not personal data once the corresponding `users` row is hard-deleted.
- **Why superior.** Reconciles the two requirements without sacrificing audit integrity.

### F4 — CSP `style-src 'unsafe-inline'` is overbroad (S3)

- **Issue.** Phase 8 §8 lists `style-src 'self' 'unsafe-inline'` because Tailwind tokens use inline styles. `unsafe-inline` weakens CSP against XSS.
- **Impact.** Marginal but real attack surface.
- **Fix.** Use CSP nonces for the small set of inline style blocks Tailwind requires (the runtime token sheet); generate per-request nonces. Nonces are rendered into the HTML by the API gateway when serving the SPA shell.
- **Why superior.** Maintains Tailwind tokens while removing the blanket `unsafe-inline`.

### F5 — WebAuthn lacks a soft "trusted device" path (S3)

- **Issue.** Phase 8 §4 enforces step-up MFA on every sensitive action. For frequent ops (granting permission, adding credentials), this is annoying.
- **Impact.** Friction; users may avoid using the optimization features.
- **Fix.** "Trusted device" enrollment within the session window: a webauthn `userVerification` confirmation extends step-up state for 30 minutes (default) instead of 10 minutes. The window is configurable per-user.
- **Why superior.** Same security floor; better UX.

---

## G. Deployment & operations (Phase 9)

### G1 — Helm rollout doesn't coordinate orchestrator + worker version pinning (S2)

- **Issue.** See C5; this is the deploy-side counterpart.
- **Impact.** A rolling deploy with adapter-version bump produces in-flight task version mismatches.
- **Fix.** Helm `pre-upgrade` hook drains the dispatcher and pauses queue intake; `post-upgrade` hook resumes only after all worker pods report ready. Implemented via a simple "deploy-coordinator" Job that flips a feature flag.
- **Why superior.** Coordinated, scriptable, idempotent.

### G2 — Backup of `kek/backups` itself is fragile (S2)

- **Issue.** Phase 8 §3.4 stores Vault unseal in cloud KMS. The unseal of `kek/backups` is also Vault-bound. If we lose the Vault cluster *and* the cloud KMS root, we lose backups.
- **Impact.** Catastrophic-but-very-rare disaster scenario where DR fails closed.
- **Fix.** Shamir-split the Vault unseal recovery key into **5 of 9** shares held by separate operator humans (per the Vault recommendation). Yearly drill rotates shares. Cloud KMS auto-unseal remains the hot path; Shamir is the cold recovery.
- **Why superior.** Adds a recovery path that doesn't depend on a single cloud account or vendor.

### G3 — Per-service liveness vs readiness is identical (S3)

- **Issue.** Most apps use the same handler for `/healthz` and `/readyz`. They mean different things in k8s.
- **Impact.** A startup-incomplete pod begins receiving traffic; a degraded pod is killed and restarted instead of removed from rotation.
- **Fix.** `/healthz` checks process is alive (always returns 200 if reachable); `/readyz` checks: PG reachable, Redis reachable, Vault reachable, BullMQ connected, OTel exporter healthy, dependent services responsive. Kubernetes `livenessProbe` → `/healthz`; `readinessProbe` → `/readyz`.
- **Why superior.** Standard k8s pattern; corrects a common misconfiguration.

### G4 — `analytics-events` continuous aggregates not specified (S3)

- **Issue.** Phase 4 §10 mentions "materialized views / continuous aggregates" but doesn't specify which.
- **Impact.** Implementation can't begin without resolving.
- **Fix.** Use **`pg_partman` partitions + `pg_cron`-driven incremental refreshes** for daily/weekly/monthly rollups into `analytics_rollups`. The refresh function is idempotent and sets `bucket_start` deterministically.
- **Why superior.** Pure PostgreSQL, no extension drift; fits our managed-PG constraint.

### G5 — Egress allowlist for workers is per-platform; ATS subdomains unaccounted (S3)

- **Issue.** Phase 9 §7.3 lists `linkedin.com`, `naukri.com`, etc. ATS handoffs (Workday tenants like `mycompany.wd1.myworkdayjobs.com`) won't pass.
- **Impact.** Worker can't even *load* the redirect target to detect-and-skip cleanly.
- **Fix.** Add a meta-allowlist of common ATS host patterns (`*.workday.com`, `*.myworkdayjobs.com`, `boards.greenhouse.io`, `jobs.lever.co`, `*.smartrecruiters.com`, `*.ashbyhq.com`). Workers are allowed to **load** these to detect, but not to **submit** until the corresponding ATS adapter ships.
- **Why superior.** Lets us collect telemetry and produce a useful skip reason without expanding the ATS scope.

### G6 — Disaster recovery drill cadence is described but not encoded (S3)

- **Issue.** Phase 9 §11.2 says "quarterly drills" but no automation enforces it.
- **Impact.** "We'll do it next quarter" until we don't.
- **Fix.** A scheduler-driven job opens a `dr-drill` issue 30 days before the quarter end and **fails the next release** (CI gate) if a corresponding "DR-DRILL-PASSED" tag isn't present in the prior 90 days.
- **Why superior.** Forcing function; DR drills happen.

---

## H. Cross-cutting

### H1 — Clock skew across services not addressed (S2)

- **Issue.** Freshness ranking depends on `posted_at` and worker clock. Different pods can disagree by seconds-to-minutes.
- **Impact.** A "5h-old" job in PG can be "5h:01s" elsewhere; the freshness tier flips at the boundary.
- **Fix.** All services run `chrony` synced to a tight-tolerance NTP source. The PG `now()` is the authoritative time for any mutation. Workers compute "freshness as of dispatch tick" using the orchestrator's clock, not their own; the value is included in the task payload.
- **Why superior.** Single authoritative clock for the decision; workers don't second-guess.

### H2 — No data residency story for self-host (S3)

- **Issue.** Self-host customers in EU need EU residency; we describe a hosted single-region default.
- **Impact.** Self-host marketing claim is shaky.
- **Fix.** Self-host's `selfhost.compose.yaml` ships with `S3_REGION` and `KMS_REGION` as required env; the operator chooses; we don't build cross-region features that contradict residency.
- **Why superior.** Honest scope; aligns with self-host's "operator-controlled" promise.

### H3 — Telemetry retention outlives the user (S3)

- **Issue.** Logs and traces in Loki/Tempo aren't included in account-deletion cascade.
- **Impact.** Long-tail PII residue in observability data.
- **Fix.** Loki/Tempo retention 90 days hot, 180 days cold, then deleted. Account deletion deletes the user's log streams via the Loki/Tempo APIs as part of the reaper.
- **Why superior.** Brings observability under the same lifecycle as primary data.

### H4 — `tools/db-scrub` PII rules are unspecified (S3)

- **Issue.** Phase 8 §15 mentions a scrub job but doesn't enumerate fields.
- **Impact.** Staging refresh could leak PII to non-prod environments.
- **Fix.** Explicit YAML manifest at `tools/db-scrub/rules.yaml` listing every column and its scrub strategy (`drop`, `hash`, `fake`, `keep`). CI checks every new column against the manifest; a missing entry fails the migration check.
- **Why superior.** Fail-closed; a new PII column cannot ship without an explicit decision.

---

## Severity tally

| Severity | Count | Examples |
| --- | --- | --- |
| S1 (Blocker) | 4 | A1, B1, B3, F1 |
| S2 (Material) | 16 | A2, A3, A4, A8, B2, B4, B7, C1, C2, C7, D1, D2, D3, E2, F2, F3, G1, G2, H1 |
| S3 (Refinement) | ~18 | A5–A8, B5–B6, B8, C3–C6, D4–D7, E1, E3–E4, F4–F5, G3–G6, H2–H4 |

**All four S1 blockers must be fixed in M0 or M1.** Material findings are scheduled in [`03-implementation-plan.md`](./03-implementation-plan.md) per their natural milestone owner. Refinements ride along with their adjacent feature work.

---

## What this audit *did not* find

For completeness, here are claims I verified against the architecture and found **already correctly handled**:

- Idempotent retries of apply tasks (A1 fix preserves this).
- Encryption at rest for all sensitive columns and object-storage objects.
- WebAuthn-first auth.
- Permission-gated mutations.
- Audit chain coverage for every consequential action.
- Forward-only migrations.
- Per-user DEK destruction on account deletion.
- LinkedIn-first adapter sequencing in the roadmap.
- Sequential per `(user, platform)` concurrency rule.
- Real freshness ranking and stale-listing rejection.
- AI decision audit per call.
- Backups with KMS-bound encryption.
- Two-reviewer rule on auth/crypto/migrations/AI prompts via CODEOWNERS.

The architecture's posture is right. The audit's job was to fix the cracks, not the foundation.
