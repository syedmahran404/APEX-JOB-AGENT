# Audit Step 5 — Database Additions & Index Revisions

This document complements [`docs/architecture/03-database-design.md`](../architecture/03-database-design.md). It does **not** restate the original schema; it specifies:

1. **Corrections** to existing tables (audit Step 1).
2. **New tables** introduced by audit findings + missing features (audit Step 2).
3. **Revised indexing strategy** that the new query patterns demand.
4. **Partitioning corrections** based on observed growth shapes.

Conventions established in Phase 3 carry over: `gen_random_uuid()` PKs; `TIMESTAMPTZ` everywhere; `*_enc` columns for AES-GCM ciphertexts wrapped with the user DEK; `BIGINT` minor units for money; `CITEXT` for case-insensitive identifiers.

---

## 1. Corrections to existing tables

### 1.1 `applications` — partial unique index (audit fix A1)

**Drop:** `UNIQUE (user_id, job_id)` constraint defined in Phase 3 §4.6.

**Add:**

```sql
CREATE UNIQUE INDEX applications_user_job_active_idx
  ON applications(user_id, job_id)
  WHERE status NOT IN (
    'failed_selector_drift','failed_platform_error',
    'skipped_human_required','skipped_low_score','skipped_stale','duplicate'
  );
```

The `idempotency_key UNIQUE` constraint is retained as a second guard.

### 1.2 `embeddings` — split per dimension (audit fix A2)

**Drop:** `embeddings` table from Phase 3 §4.2.

**Add:**

```sql
CREATE TABLE embeddings_1024 (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL,                 -- multi-tenant ready (audit fix A8)
  owner_kind  TEXT NOT NULL CHECK (owner_kind IN
    ('qa_memory','frequent_answer','project','experience','skill','resume_version','job')),
  owner_id    UUID NOT NULL,
  model       TEXT NOT NULL,
  vector      vector(1024) NOT NULL,
  text_hash   BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX embeddings_1024_user_owner_idx
  ON embeddings_1024(user_id, owner_kind, owner_id);

CREATE TABLE embeddings_3072 ( ... same shape, vector vector(3072) NOT NULL ... );
CREATE INDEX embeddings_3072_user_owner_idx ... ;

-- Read view used by repositories that don't care about dim:
CREATE VIEW embeddings AS
  SELECT id, user_id, tenant_id, owner_kind, owner_id, model, text_hash, created_at,
         1024 AS dim
    FROM embeddings_1024
  UNION ALL
  SELECT id, user_id, tenant_id, owner_kind, owner_id, model, text_hash, created_at,
         3072 AS dim
    FROM embeddings_3072;
```

**ANN indexes (HNSW for high-churn corpora, IVFFlat for slow-churn — audit fix D2):**

```sql
-- High-churn (qa_memory, frequent_answers): HNSW
CREATE INDEX embeddings_1024_qa_hnsw_idx
  ON embeddings_1024
  USING hnsw (vector vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE owner_kind IN ('qa_memory','frequent_answer');

-- Slow-churn (jobs, experiences, projects): IVFFlat
CREATE INDEX embeddings_1024_slow_ivf_idx
  ON embeddings_1024
  USING ivfflat (vector vector_cosine_ops)
  WITH (lists = 100)
  WHERE owner_kind IN ('job','experience','project','skill','resume_version');

-- Mirror for embeddings_3072 once an active 3072-dim model is selected.
```

### 1.3 `audit_log` — per-tenant chain (audit fix A8)

**Add columns:**

```sql
ALTER TABLE audit_log ADD COLUMN tenant_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';
-- The default is the singleton tenant pre-M9; every new write sets the real tenant_id.
```

**New table:**

```sql
CREATE TABLE audit_chain_heads (
  tenant_id UUID PRIMARY KEY,
  head_hash BYTEA NOT NULL,
  head_id   BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Trigger update:** the `BEFORE INSERT` trigger reads `audit_chain_heads` for the row's `tenant_id`, computes `hash = SHA-256(prev_hash || canonical(row-without-hash))`, and updates `audit_chain_heads` atomically. UPDATE/DELETE on `audit_log` remain blocked.

### 1.4 PII columns gain rotation version (audit fix A6)

```sql
ALTER TABLE personal_info  ADD COLUMN dek_version SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE platform_credentials ADD COLUMN dek_version SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE totp_secrets   ADD COLUMN dek_version SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE qa_memory      ADD COLUMN dek_version SMALLINT NOT NULL DEFAULT 1;
```

A background re-encryption job (`apps/scheduler`) iterates rows where `dek_version < users.dek_version_current` and rewrites in-place under a row lock.

### 1.5 `qa_memory.application_id` — drop FK, keep column (audit fix A5)

```sql
ALTER TABLE qa_memory DROP CONSTRAINT qa_memory_application_fk;
-- Column remains; lifecycle is intentionally decoupled.
```

### 1.6 `applications.was_dry_run` and `job_runs.dry_run` (missing feature §5)

```sql
ALTER TABLE job_runs     ADD COLUMN dry_run BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE applications ADD COLUMN was_dry_run BOOLEAN NOT NULL DEFAULT false;
```

### 1.7 `applications.last_refreshed_at` and new status (missing feature §17)

```sql
ALTER TABLE applications ADD COLUMN last_refreshed_at TIMESTAMPTZ NULL;
ALTER TYPE application_status ADD VALUE IF NOT EXISTS 'closed_no_response';
```

### 1.8 `jobs.canonical_key` (missing feature §6)

```sql
ALTER TABLE jobs ADD COLUMN canonical_key TEXT NOT NULL DEFAULT '';
-- Populated by adapter normalize() during discovery; default '' allowed only during migration backfill.
CREATE INDEX jobs_canonical_key_idx ON jobs(canonical_key);
```

### 1.9 `applications.adapter_version` (audit fix C5)

```sql
ALTER TABLE applications ADD COLUMN adapter_version TEXT NOT NULL DEFAULT '0.0.0';
```

### 1.10 `users.email_status` (missing feature §12)

```sql
ALTER TABLE users ADD COLUMN email_status TEXT NOT NULL DEFAULT 'unverified'
  CHECK (email_status IN ('unverified','verified','bouncing','complained','suppressed'));
```

### 1.11 `ai_decisions` safety fields (missing feature §14)

```sql
ALTER TABLE ai_decisions ADD COLUMN safety_score   NUMERIC(4,3) NULL;
ALTER TABLE ai_decisions ADD COLUMN safety_action  TEXT NULL CHECK (safety_action IN ('passed','redacted','blocked'));
ALTER TABLE ai_decisions ADD COLUMN governor_action TEXT NULL CHECK (governor_action IN ('pass','downgrade','skip'));
```

---

## 2. New tables

All new tables carry `tenant_id` from day one (multi-tenant ready) and `created_at`/`updated_at` per convention.

### 2.1 `outbox_events` (audit fix A3)

```sql
CREATE TABLE outbox_events (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  aggregate     TEXT NOT NULL,                   -- 'run','application','user','security'
  aggregate_id  UUID NOT NULL,
  topic         TEXT NOT NULL,                   -- 'events:run:{id}','events:user:{id}'
  payload       JSONB NOT NULL,
  delivered_at  TIMESTAMPTZ NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT
);
CREATE INDEX outbox_events_undelivered_idx ON outbox_events(id) WHERE delivered_at IS NULL;
CREATE INDEX outbox_events_aggregate_idx   ON outbox_events(aggregate, aggregate_id, id);
```

### 2.2 `idempotency_keys` (audit fix A4)

```sql
CREATE TABLE idempotency_keys (
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key               TEXT NOT NULL,
  method            TEXT NOT NULL,
  path              TEXT NOT NULL,
  request_hash      BYTEA NOT NULL,
  response_status   INTEGER NOT NULL,
  response_envelope JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys(expires_at);
```

### 2.3 `job_canonical_keys` (missing feature §6)

```sql
CREATE TABLE job_canonical_keys (
  canonical_key         TEXT PRIMARY KEY,
  representative_job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  variant_count         INTEGER NOT NULL DEFAULT 1
);
```

### 2.4 `ip_reputation_events` (audit fix C4)

```sql
CREATE TABLE ip_reputation_events (
  id           BIGSERIAL PRIMARY KEY,
  ip_inet      INET NOT NULL,
  platform_id  UUID NOT NULL REFERENCES platforms(id),
  event_kind   TEXT NOT NULL,                    -- 'captcha','rate_limit','session_expired','login_failed'
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ip_rep_recent_idx ON ip_reputation_events(ip_inet, platform_id, occurred_at DESC);
-- Rolling 7-day retention via pg_partman or daily prune job.
```

### 2.5 `embedding_refresh_queue` (audit fix D7)

```sql
CREATE TABLE embedding_refresh_queue (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL,
  owner_kind  TEXT NOT NULL,
  owner_id    UUID NOT NULL,
  reason      TEXT NOT NULL,                     -- 'edited','model_swap','imported'
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ NULL,
  attempts    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX embedding_refresh_pending_idx
  ON embedding_refresh_queue(enqueued_at)
  WHERE processed_at IS NULL;
```

### 2.6 Scheduler tables (missing feature §1)

```sql
CREATE TABLE schedules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL,
  name        TEXT NOT NULL,
  cron        TEXT NOT NULL,                     -- 5-field cron, validated
  timezone    TEXT NOT NULL,                     -- IANA, e.g., 'Asia/Kolkata'
  payload     JSONB NOT NULL,                    -- run config to materialize on fire
  enabled     BOOLEAN NOT NULL DEFAULT true,
  last_fired_at TIMESTAMPTZ NULL,
  next_fire_at  TIMESTAMPTZ NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX schedules_due_idx ON schedules(next_fire_at) WHERE enabled = true;

CREATE TABLE schedule_runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id UUID NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  run_id      UUID NULL REFERENCES job_runs(id),
  fired_at    TIMESTAMPTZ NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('triggered','skipped_overlap','skipped_quota','triggered_dry_run','failed_to_trigger'))
);

CREATE TABLE saved_searches (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id    UUID NOT NULL,
  name         TEXT NOT NULL,
  filters      JSONB NOT NULL,                   -- platforms, query, locations, salary, remote kind
  alert_freq   TEXT NOT NULL CHECK (alert_freq IN ('off','realtime','hourly','daily','weekly')),
  last_run_at  TIMESTAMPTZ NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE saved_search_matches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  saved_search_id UUID NOT NULL REFERENCES saved_searches(id) ON DELETE CASCADE,
  job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  matched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  alerted_at      TIMESTAMPTZ NULL,
  UNIQUE (saved_search_id, job_id)
);

CREATE TABLE system_jobs (
  id           TEXT PRIMARY KEY,                 -- e.g., 'partitions-rollover'
  cron         TEXT NOT NULL,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  last_run_at  TIMESTAMPTZ NULL,
  last_success_at TIMESTAMPTZ NULL,
  last_status  TEXT,
  next_run_at  TIMESTAMPTZ NOT NULL,
  description  TEXT,
  runbook_url  TEXT
);
```

### 2.7 Webhooks (missing feature §2)

```sql
CREATE TABLE webhooks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id    UUID NOT NULL,
  url          TEXT NOT NULL,
  secret_enc   BYTEA NOT NULL,                  -- HMAC secret, wrapped with user DEK
  events       TEXT[] NOT NULL,                 -- subscribed event kinds
  enabled      BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_success_at TIMESTAMPTZ NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE webhook_deliveries (
  id            BIGSERIAL PRIMARY KEY,
  webhook_id    UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  tenant_id     UUID NOT NULL,
  event_kind    TEXT NOT NULL,
  event_id      UUID NOT NULL,
  attempt       INTEGER NOT NULL,
  status_code   INTEGER NULL,
  duration_ms   INTEGER NULL,
  bytes_out     INTEGER NULL,
  bytes_in      INTEGER NULL,
  error         TEXT NULL,
  delivered_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_webhook_idx ON webhook_deliveries(webhook_id, delivered_at DESC);
```

### 2.8 Bulk operations (missing feature §4)

```sql
CREATE TABLE bulk_operations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id    UUID NOT NULL,
  kind         TEXT NOT NULL,                    -- 'withdraw','approve_suggestions','skip_jobs','rerank'
  params       JSONB NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('queued','running','paused','done','failed','undone')),
  total        INTEGER NOT NULL,
  succeeded    INTEGER NOT NULL DEFAULT 0,
  failed       INTEGER NOT NULL DEFAULT 0,
  undo_until   TIMESTAMPTZ NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ NULL
);

CREATE TABLE bulk_operation_items (
  id              BIGSERIAL PRIMARY KEY,
  bulk_op_id      UUID NOT NULL REFERENCES bulk_operations(id) ON DELETE CASCADE,
  target_id       UUID NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','done','failed','undone')),
  error           TEXT NULL,
  processed_at    TIMESTAMPTZ NULL
);
CREATE INDEX bulk_op_items_pending_idx
  ON bulk_operation_items(bulk_op_id, id) WHERE status = 'pending';
```

### 2.9 Email ingestion (missing feature §3)

```sql
CREATE TABLE inbox_aliases (
  alias        CITEXT PRIMARY KEY,                -- e.g., 'u-3f5a@inbox.apex.example'
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id    UUID NOT NULL,
  rotated_from CITEXT NULL,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE email_messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id     UUID NOT NULL,
  alias         CITEXT NOT NULL,
  message_id    TEXT NOT NULL,
  in_reply_to   TEXT NULL,
  from_addr     CITEXT NOT NULL,
  subject       TEXT,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_uri       TEXT NOT NULL,                    -- s3://...; encrypted at rest
  body_excerpt_enc BYTEA,                         -- short snippet, encrypted
  classified_status TEXT NULL,
  classifier_confidence NUMERIC(4,3) NULL,
  application_match_id UUID NULL,
  UNIQUE (user_id, message_id)
);

CREATE TABLE email_application_matches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_message_id UUID NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  application_id   UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  confidence       NUMERIC(4,3) NOT NULL,
  applied_status   TEXT NOT NULL,
  applied_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_overridden  BOOLEAN NOT NULL DEFAULT false
);
```

### 2.10 Customer-support consented impersonation (missing feature §7)

```sql
CREATE TABLE support_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id     UUID NOT NULL REFERENCES users(id),
  tenant_id    UUID NOT NULL,
  reason       TEXT NOT NULL,
  scope        JSONB NOT NULL,                    -- which surfaces are accessible
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ NULL
);

CREATE TABLE support_actions (
  id           BIGSERIAL PRIMARY KEY,
  session_id   UUID NOT NULL REFERENCES support_sessions(id) ON DELETE CASCADE,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  action       TEXT NOT NULL,
  target_kind  TEXT,
  target_id    UUID,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb
);
```

### 2.11 Feature flags + experiments (missing feature §10)

```sql
CREATE TABLE feature_flags (
  key          TEXT PRIMARY KEY,
  description  TEXT,
  kind         TEXT NOT NULL CHECK (kind IN ('boolean','variant','targeted')),
  default_value JSONB NOT NULL,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE feature_flag_rules (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_key     TEXT NOT NULL REFERENCES feature_flags(key) ON DELETE CASCADE,
  ordinal      INTEGER NOT NULL,
  condition    JSONB NOT NULL,                    -- e.g., { "tenant_id": [...] } or { "plan": "pro" }
  value        JSONB NOT NULL,
  rollout_pct  NUMERIC(5,2) NOT NULL DEFAULT 100,
  UNIQUE (flag_key, ordinal)
);

CREATE TABLE experiment_assignments (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  flag_key   TEXT NOT NULL REFERENCES feature_flags(key) ON DELETE CASCADE,
  variant    TEXT NOT NULL,
  bucketed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, flag_key)
);

CREATE TABLE experiment_outcomes (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  flag_key    TEXT NOT NULL,
  variant     TEXT NOT NULL,
  metric      TEXT NOT NULL,
  value       NUMERIC,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 2.12 Notification preferences (missing feature §9)

```sql
CREATE TABLE notification_preferences (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_kind   TEXT NOT NULL,
  channel      TEXT NOT NULL CHECK (channel IN ('inapp','email','push','webhook')),
  enabled      BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, event_kind, channel)
);

ALTER TABLE notifications
  ADD COLUMN deferred_until TIMESTAMPTZ NULL;
```

### 2.13 Email transactional system (missing feature §12)

```sql
CREATE TABLE email_templates (
  key          TEXT NOT NULL,
  version      INTEGER NOT NULL,
  locale       TEXT NOT NULL,
  subject      TEXT NOT NULL,
  body_html    TEXT NOT NULL,
  body_text    TEXT NOT NULL,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (key, version, locale)
);

CREATE TABLE email_deliveries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NULL REFERENCES users(id),
  template_key TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  to_addr      CITEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('queued','sent','delivered','bounced','complained','suppressed')),
  provider     TEXT NOT NULL,
  provider_id  TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  sent_at      TIMESTAMPTZ NULL,
  delivered_at TIMESTAMPTZ NULL,
  error        TEXT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE email_suppressions (
  email        CITEXT PRIMARY KEY,
  reason       TEXT NOT NULL,
  added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  source       TEXT NOT NULL CHECK (source IN ('bounce','complaint','manual','unsubscribe'))
);
```

### 2.14 Onboarding telemetry (missing feature §13)

```sql
CREATE TABLE onboarding_milestones (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  milestone      TEXT NOT NULL,                  -- 'consent','resume_uploaded','profile_confirmed','preferences_set','first_platform','first_run','first_application'
  achieved_at    TIMESTAMPTZ NOT NULL,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (user_id, milestone)
);
```

### 2.15 Security rules engine (missing feature §18)

```sql
CREATE TABLE security_rules (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key          TEXT NOT NULL UNIQUE,
  description  TEXT NOT NULL,
  event_kind   TEXT NOT NULL,
  threshold    INTEGER NOT NULL,
  window_secs  INTEGER NOT NULL,
  scope        JSONB NOT NULL,                   -- { "per": "user" | "ip" | "tenant" }
  action       TEXT NOT NULL CHECK (action IN ('lock_user','pause_platform','require_step_up','page_oncall','notify_user')),
  enabled      BOOLEAN NOT NULL DEFAULT true,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE security_rule_triggers (
  id          BIGSERIAL PRIMARY KEY,
  rule_id     UUID NOT NULL REFERENCES security_rules(id),
  user_id     UUID NULL,
  ip_inet     INET NULL,
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  details     JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX security_rule_triggers_recent_idx
  ON security_rule_triggers(triggered_at DESC);
```

### 2.16 Per-tenant cost attribution (missing feature §16)

```sql
CREATE TABLE tenant_cost_rollups (
  tenant_id    UUID NOT NULL,
  day          DATE NOT NULL,
  cost_class   TEXT NOT NULL CHECK (cost_class IN ('ai','compute','storage','egress','platform_actions')),
  cost_usd     NUMERIC(12,6) NOT NULL DEFAULT 0,
  units        BIGINT NOT NULL DEFAULT 0,
  details      JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, day, cost_class)
);

CREATE TABLE worker_compute_attributions (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL,
  user_id      UUID NOT NULL,
  platform_id  UUID NOT NULL,
  run_id       UUID NULL,
  task_id      UUID NULL,
  duration_ms  BIGINT NOT NULL,
  cpu_ms       BIGINT NULL,
  rss_peak_mb  INTEGER NULL,
  ended_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX worker_compute_tenant_idx ON worker_compute_attributions(tenant_id, ended_at DESC);
```

### 2.17 Data export schedules + jobs (missing feature §20)

```sql
CREATE TABLE data_export_schedules (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  frequency    TEXT NOT NULL CHECK (frequency IN ('off','weekly','monthly')),
  channel      TEXT NOT NULL CHECK (channel IN ('email','webhook','download')),
  last_run_at  TIMESTAMPTZ NULL,
  PRIMARY KEY (user_id)
);

CREATE TABLE data_export_jobs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
  format       TEXT NOT NULL DEFAULT 'zip',
  size_bytes   BIGINT NULL,
  uri          TEXT NULL,                         -- presigned, short-TTL
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ NULL
);
```

### 2.18 Optimization suggestions (was implicit in Phase 4 §10; now explicit)

```sql
CREATE TABLE optimization_suggestions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL,
  area            TEXT NOT NULL,                   -- 'headline','summary','skills','experience','projects','links','resume_bullet'
  issue           TEXT NOT NULL,
  expected_benefit TEXT NOT NULL,
  current_text    TEXT NOT NULL,
  proposed_text   TEXT NOT NULL,
  confidence      NUMERIC(4,3) NOT NULL,
  references      JSONB NOT NULL DEFAULT '[]'::jsonb,
  ai_decision_id  BIGINT NULL,                     -- references ai_decisions
  status          TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired')) DEFAULT 'pending',
  decided_at      TIMESTAMPTZ NULL,
  decided_by      UUID NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX optimization_suggestions_user_pending_idx
  ON optimization_suggestions(user_id) WHERE status = 'pending';
```

---

## 3. Revised indexing strategy

### 3.1 Hot read queries — index per query

Every index has a documented query in `docs/db/indexes.md` (added in Phase 1). The table below covers indexes added or revised by this audit; existing Phase-3 indexes are retained.

| Query | Index |
| --- | --- |
| User's pending applications by status, latest first | `applications(user_id, status, submitted_at DESC)` (existing) |
| Run progress | `applications(run_id)` (existing) |
| Discovery freshness | `jobs(platform_id, posted_at DESC)` (existing) |
| Cross-platform dedupe | `jobs(canonical_key)` (NEW) |
| Q&A memory recall (lex) | `qa_memory(user_id, question_norm)` (existing); add `gin_trgm` on `question_norm` for fuzzy |
| Q&A memory recall (sem) | `embeddings_1024_qa_hnsw_idx` (NEW; HNSW) |
| Outbox drainer | `outbox_events_undelivered_idx` (NEW) |
| Per-aggregate FIFO for relay | `outbox_events_aggregate_idx` (NEW) |
| Idempotency replay | PK `(user_id, key)` (NEW) |
| Idempotency reaper | `idempotency_keys_expires_idx` (NEW) |
| Schedule due | `schedules_due_idx` partial WHERE enabled=true (NEW) |
| Saved-search dedupe | `saved_search_matches UNIQUE(saved_search_id, job_id)` (NEW) |
| Bulk-op next item | `bulk_op_items_pending_idx` partial (NEW) |
| Webhook recent deliveries | `webhook_deliveries_webhook_idx` (NEW) |
| IP rep recent | `ip_rep_recent_idx` (NEW) |
| Pending optimizations | `optimization_suggestions_user_pending_idx` partial (NEW) |
| Worker compute by tenant | `worker_compute_tenant_idx` (NEW) |

### 3.2 Composite indexes for cross-tenant probes (Phase 8)

When RLS lands, queries naturally include `tenant_id`. The leading column on every multi-tenant table's hot index is `tenant_id` to keep RLS-policy plans efficient:

```sql
-- Example: applications hot read becomes
CREATE INDEX applications_tenant_user_status_idx
  ON applications(tenant_id, user_id, status, submitted_at DESC);
```

This is added in Phase 8 alongside the RLS retrofit.

---

## 4. Partitioning corrections

### 4.1 Already-partitioned tables (Phase 3)

- `analytics_events` — monthly, 24-month retention.
- `application_events` — monthly, 24-month retention.
- `run_events` — monthly, 24-month retention.
- `ai_decisions` — weekly, 13-week online + archive.

These remain.

### 4.2 New partitioning decisions

- `application_questions` — partitioned by `created_at` monthly **once row count crosses 10M** (audit fix A7). The schema is partition-ready (PK includes `created_at`); cutover is a one-time migration in Phase 4.
- `application_files` — same trigger and treatment.
- `webhook_deliveries` — partitioned by `delivered_at` monthly from day one (high-write, append-only).
- `email_messages` — partitioned by `received_at` monthly (append-mostly, retention 18 months).
- `worker_compute_attributions` — partitioned by `ended_at` monthly (append-only).
- `outbox_events` — **not partitioned**. The `delivered_at IS NULL` partial index keeps the hot set small; delivered rows can be archived weekly to cold storage and pruned.

### 4.3 Continuous aggregates / rollups

`analytics_rollups` (existing) is refreshed nightly by `apps/scheduler` (`analytics-rollups.ts`) using incremental SQL drawn from the partitioned `analytics_events`. The job is idempotent and tolerates partial failure. Audit fix G4 is realized here.

---

## 5. Migration discipline (recap)

- All migrations are forward-only.
- Breaking changes split into add → backfill → cutover → drop across releases.
- Extensions, partitioning, triggers, and views appended as raw SQL after the Prisma-generated portion, with `-- raw:` comments.
- A migration adding a new column with `BYTEA`/`*_enc` shape **must** add a corresponding row in `tools/db-scrub/rules.yaml` or the lint check fails.
- A migration touching `audit_log`, `personal_info`, `platform_credentials`, or any `*_dek_version` column requires the two-reviewer rule from CODEOWNERS.

---

## 6. Final table count

| Group | Phase 3 baseline | Audit additions | Total |
| --- | --- | --- | --- |
| Identity & access | 9 | 0 | 9 |
| Profile knowledge base | 11 | 1 (`embedding_refresh_queue`) | 12 |
| Resumes | 4 | 0 | 4 |
| Platforms & credentials | 5 | 0 | 5 |
| Discovery & jobs | 4 | 1 (`job_canonical_keys`) | 5 |
| Runs & applications | 6 | 0 (column adds only) | 6 |
| AI decisions & cost | 5 | 0 (column adds only) | 5 |
| Audit, security, analytics | 6 | 4 (`audit_chain_heads`, `ip_reputation_events`, `security_rules`, `security_rule_triggers`) | 10 |
| Scheduler | 0 | 5 (`schedules`, `schedule_runs`, `saved_searches`, `saved_search_matches`, `system_jobs`) | 5 |
| Webhooks | 0 | 2 | 2 |
| Bulk ops | 0 | 2 | 2 |
| Email | 0 | 6 (3 ingest + 3 transactional) | 6 |
| Support | 0 | 2 | 2 |
| Feature flags / experiments | 0 | 4 | 4 |
| Notifications | 1 (Phase 3) | 1 (`notification_preferences`) + col add | 2 |
| Cost attribution | 0 | 2 | 2 |
| Data export | 0 | 2 | 2 |
| Outbox + idempotency | 0 | 2 | 2 |
| Optimization | 0 | 1 | 1 |

**Phase 3 baseline: ~46 tables.**
**After audit: ~74 tables** (within the prediction in [`02-missing-features.md`](./02-missing-features.md)).

The `embeddings` table split adds two physical tables and one view — counted once above.

---

## 7. Why this schema is right

- **Every user-owned row carries `user_id` and `tenant_id` from day one.** The Phase-8 RLS retrofit is mechanical, not a redesign.
- **Every hot-write append-mostly table is partitioned or partition-ready.** Maintenance pain is bounded.
- **Every consequential action writes a row** — to `audit_log` for security-sensitive actions, to `application_events` for application progress, to `run_events` for runs, to `ai_decisions` for AI calls, to `webhook_deliveries` for outbound webhooks, to `support_actions` for impersonation, to `experiment_outcomes` for A/B telemetry. There is one place to look, per concern.
- **Every encrypted column is paired with `dek_version`.** Rotation is a background sweep, never a downtime event.
- **Every dimension of evolution is anticipated.** Embedding-model swaps (sibling tables), prompt versions (`ai_prompts.version`), adapter versions (`applications.adapter_version`), permission scopes (JSONB `scope`), schedules (cron), feature flags (kind = boolean/variant/targeted).

The schema does not do everything. It does what the architecture promises — and now, with audit corrections folded in, it does so consistently.
