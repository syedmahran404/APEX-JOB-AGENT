-- Phase 2 — Automation Engine schema.
--
-- Adds: jobs, job_canonical_keys, job_runs, run_stages, applications,
-- application_questions, application_files, screenshots, application_events,
-- run_events, platform_accounts, platform_credentials, platform_sessions,
-- platform_permissions.
--
-- Audit fixes folded in:
--   A1  Partial unique index on applications (NOT a hard UNIQUE).
--   A6  dek_version on every PII/secret table.
--   A7  Append-only event tables use (id, occurred_at) composite PK so
--       monthly partitioning can be added later without a rewrite.
--   B5  applications.idempotency_key carries both run-based and manual shapes.
--   C1  job_canonical_keys + jobs.canonical_key for cross-platform dedupe.
--   C5  applications.adapter_version pins which adapter version applied.
--   F1  platform_credentials.cipher is BYTEA + AAD reconstructible at runtime.

-- =============================================================================
-- ENUMS
-- =============================================================================

DO $$ BEGIN
  CREATE TYPE freshness_tier AS ENUM ('t5h','t12h','t24h','t5d','stale');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE run_mode AS ENUM ('single','multi');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE run_status AS ENUM ('pending','planning','running','paused','stopped','done','failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE stage_status AS ENUM ('pending','discovering','applying','done','skipped','failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE application_status AS ENUM (
    'queued','submitting','submitted','viewed','shortlisted',
    'rejected','interview_scheduled','offer','withdrawn',
    'closed_no_response',
    'skipped_human_required','skipped_low_score','skipped_stale','skipped_external_ats',
    'skipped_recon_pending','skipped_duplicate',
    'failed_selector_drift','failed_platform_error',
    'duplicate'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE platform_account_status AS ENUM ('connected','disconnected','expired','blocked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE session_health AS ENUM ('fresh','stale','blocked','unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE autonomous_mode AS ENUM ('assisted','autonomous');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE remote_kind AS ENUM ('remote','hybrid','onsite','any');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================================
-- JOB CANONICAL KEYS (audit fix C1)
-- =============================================================================

CREATE TABLE "job_canonical_keys" (
  "canonical_key"           TEXT PRIMARY KEY,
  "representative_job_id"   UUID NOT NULL,
  "first_seen_at"           TIMESTAMPTZ NOT NULL DEFAULT now(),
  "variant_count"           INTEGER NOT NULL DEFAULT 1
);

-- =============================================================================
-- JOBS
-- =============================================================================

CREATE TABLE "jobs" (
  "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"        UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  "platform_id"      UUID NOT NULL REFERENCES "platforms"("id"),
  "external_id"      TEXT NOT NULL,
  "url"              TEXT NOT NULL,
  "title"            TEXT NOT NULL,
  "company"          TEXT,
  "location"         TEXT,
  "remote_kind"      remote_kind,
  "posted_at"        TIMESTAMPTZ,
  "posted_at_uncertain" BOOLEAN NOT NULL DEFAULT false,
  "discovered_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "freshness"        freshness_tier,
  "description_md"   TEXT,
  "raw"              JSONB,
  "applicants"       INTEGER,
  "salary_min"       BIGINT,
  "salary_max"       BIGINT,
  "currency"         CHAR(3),
  "is_quick_apply"   BOOLEAN,
  "required_skills"  TEXT[] NOT NULL DEFAULT '{}',
  "canonical_key"    TEXT NOT NULL DEFAULT '',
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "jobs_platform_external_unique" UNIQUE ("platform_id", "external_id")
);
CREATE INDEX "jobs_platform_posted_idx" ON "jobs"("platform_id", "posted_at" DESC);
CREATE INDEX "jobs_canonical_key_idx" ON "jobs"("canonical_key");
CREATE INDEX "jobs_title_trgm_idx" ON "jobs" USING gin ("title" gin_trgm_ops);
CREATE INDEX "jobs_tenant_idx" ON "jobs"("tenant_id");

-- Backfill the FK from canonical_keys to jobs (it was forward-declared above).
ALTER TABLE "job_canonical_keys"
  ADD CONSTRAINT "job_canonical_keys_representative_fk"
  FOREIGN KEY ("representative_job_id") REFERENCES "jobs"("id") ON DELETE CASCADE;

-- =============================================================================
-- PLATFORM ACCOUNTS / CREDENTIALS / SESSIONS / PERMISSIONS
-- =============================================================================

CREATE TABLE "platform_accounts" (
  "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"                UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  "user_id"                  UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "platform_id"              UUID NOT NULL REFERENCES "platforms"("id") ON DELETE RESTRICT,
  "display_label"            TEXT,
  "username_enc"             BYTEA,
  "status"                   platform_account_status NOT NULL DEFAULT 'connected',
  "last_login_at"            TIMESTAMPTZ NULL,
  "last_session_check_at"    TIMESTAMPTZ NULL,
  "created_at"               TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("user_id", "platform_id")
);

CREATE TABLE "platform_credentials" (
  "account_id"          UUID PRIMARY KEY REFERENCES "platform_accounts"("id") ON DELETE CASCADE,
  "cipher"              BYTEA NOT NULL,
  "cipher_aad_version"  INTEGER NOT NULL DEFAULT 1,
  "vault_key_id"        TEXT NOT NULL,
  "rotation_version"    INTEGER NOT NULL DEFAULT 1,
  "dek_version"         SMALLINT NOT NULL DEFAULT 1,
  "rotated_at"          TIMESTAMPTZ NULL,
  "expires_at"          TIMESTAMPTZ NULL,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "platform_sessions" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id"    UUID NOT NULL REFERENCES "platform_accounts"("id") ON DELETE CASCADE,
  "storage_uri"   TEXT NOT NULL,
  "expires_at"    TIMESTAMPTZ,
  "health"        session_health NOT NULL DEFAULT 'unknown',
  "last_used_at"  TIMESTAMPTZ,
  "dek_version"   SMALLINT NOT NULL DEFAULT 1,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "platform_sessions_account_idx" ON "platform_sessions"("account_id", "created_at" DESC);

CREATE TABLE "platform_permissions" (
  "user_id"               UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "platform_id"           UUID NOT NULL REFERENCES "platforms"("id") ON DELETE RESTRICT,
  "allow_apply"           BOOLEAN NOT NULL DEFAULT true,
  "allow_profile_edit"    BOOLEAN NOT NULL DEFAULT false,
  "allow_resume_edit"     BOOLEAN NOT NULL DEFAULT false,
  "autonomous_mode"       autonomous_mode NOT NULL DEFAULT 'assisted',
  "daily_application_cap" INTEGER,
  "threshold_score"       SMALLINT NOT NULL DEFAULT 70,
  "pacing_profile"        TEXT NOT NULL DEFAULT 'STRICT_DEFAULT',
  "updated_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "platform_id")
);

-- =============================================================================
-- JOB RUNS / RUN STAGES
-- =============================================================================

CREATE TABLE "job_runs" (
  "id"                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"              UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  "user_id"                UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "mode"                   run_mode NOT NULL,
  "status"                 run_status NOT NULL DEFAULT 'pending',
  "control"                TEXT NOT NULL DEFAULT 'run' CHECK ("control" IN ('run','pause','stop')),
  "target_per_platform"    INTEGER NOT NULL DEFAULT 20,
  "threshold_score"        SMALLINT NOT NULL DEFAULT 70,
  "autonomous"             BOOLEAN NOT NULL DEFAULT false,
  "dry_run"                BOOLEAN NOT NULL DEFAULT false,
  "requested_platforms"    UUID[] NOT NULL,
  "started_at"             TIMESTAMPTZ,
  "finished_at"            TIMESTAMPTZ,
  "idempotency_key"        TEXT NOT NULL,
  "config"                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  "lease_fence"            BIGINT NOT NULL DEFAULT 0,
  "owner_replica"          TEXT,
  "created_at"             TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "job_runs_idempotency_unique" UNIQUE ("user_id", "idempotency_key")
);
CREATE INDEX "job_runs_user_status_idx" ON "job_runs"("user_id", "status");
CREATE INDEX "job_runs_owner_replica_idx" ON "job_runs"("owner_replica") WHERE "status" IN ('planning','running','paused');

CREATE TABLE "run_stages" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"      UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  "run_id"         UUID NOT NULL REFERENCES "job_runs"("id") ON DELETE CASCADE,
  "platform_id"    UUID NOT NULL REFERENCES "platforms"("id"),
  "ordinal"        SMALLINT NOT NULL,
  "status"         stage_status NOT NULL DEFAULT 'pending',
  "target"         INTEGER NOT NULL,
  "applied_count"  INTEGER NOT NULL DEFAULT 0,
  "skipped_count"  INTEGER NOT NULL DEFAULT 0,
  "failed_count"   INTEGER NOT NULL DEFAULT 0,
  "started_at"     TIMESTAMPTZ,
  "finished_at"    TIMESTAMPTZ,
  "reason"         TEXT,
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "run_stages_unique_platform" UNIQUE ("run_id", "platform_id"),
  CONSTRAINT "run_stages_unique_ordinal"  UNIQUE ("run_id", "ordinal")
);
CREATE INDEX "run_stages_run_status_idx" ON "run_stages"("run_id", "status");

-- =============================================================================
-- APPLICATIONS (audit fix A1: partial unique index)
-- =============================================================================

CREATE TABLE "applications" (
  "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"                UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  "user_id"                  UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "run_id"                   UUID NULL REFERENCES "job_runs"("id") ON DELETE SET NULL,
  "stage_id"                 UUID NULL REFERENCES "run_stages"("id") ON DELETE SET NULL,
  "job_id"                   UUID NOT NULL REFERENCES "jobs"("id") ON DELETE RESTRICT,
  "platform_id"              UUID NOT NULL REFERENCES "platforms"("id"),
  "status"                   application_status NOT NULL,
  "ai_score"                 SMALLINT,
  "resume_version_id"        UUID NULL,
  "cover_letter_id"          UUID NULL,
  "freshness_at_apply"       freshness_tier,
  "submitted_at"             TIMESTAMPTZ,
  "outcome_at"               TIMESTAMPTZ,
  "last_refreshed_at"        TIMESTAMPTZ,
  "reason"                   TEXT,
  "external_application_id"  TEXT,
  "idempotency_key"          TEXT NOT NULL,
  "adapter_version"          TEXT NOT NULL DEFAULT '0.0.0',
  "was_dry_run"              BOOLEAN NOT NULL DEFAULT false,
  "created_at"               TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "applications_idempotency_unique" UNIQUE ("idempotency_key")
);

-- audit fix A1: PARTIAL unique index. Allows retry after permanent-failure terminal states.
CREATE UNIQUE INDEX "applications_user_job_active_idx"
  ON "applications"("user_id", "job_id")
  WHERE "status" NOT IN (
    'failed_selector_drift','failed_platform_error',
    'skipped_human_required','skipped_low_score','skipped_stale','skipped_external_ats','skipped_recon_pending','skipped_duplicate',
    'duplicate'
  );

CREATE INDEX "applications_user_status_idx"
  ON "applications"("user_id", "status", "submitted_at" DESC);
CREATE INDEX "applications_run_idx" ON "applications"("run_id");
CREATE INDEX "applications_stage_idx" ON "applications"("stage_id");
CREATE INDEX "applications_tenant_user_idx" ON "applications"("tenant_id", "user_id", "created_at" DESC);

-- =============================================================================
-- APPLICATION QUESTIONS / FILES / SCREENSHOTS
-- =============================================================================

CREATE TABLE "application_questions" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"       UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  "application_id"  UUID NOT NULL REFERENCES "applications"("id") ON DELETE CASCADE,
  "question_raw"    TEXT NOT NULL,
  "question_norm"   TEXT NOT NULL,
  "field_kind"      TEXT NOT NULL,
  "answer"          TEXT,
  "source"          TEXT NOT NULL CHECK ("source" IN ('frequent_answer','qa_memory','ai_generated','user_intervention')),
  "ai_decision_id"  BIGINT NULL,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "application_questions_app_idx" ON "application_questions"("application_id");

CREATE TABLE "application_files" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"       UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  "application_id"  UUID NOT NULL REFERENCES "applications"("id") ON DELETE CASCADE,
  "kind"            TEXT NOT NULL CHECK ("kind" IN ('resume','cover_letter','screenshot','dom_snapshot','attachment')),
  "uri"             TEXT NOT NULL,
  "step_label"      TEXT,
  "bytes"           BIGINT,
  "sha256"          BYTEA,
  "redacted"        BOOLEAN NOT NULL DEFAULT false,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "application_files_app_idx" ON "application_files"("application_id", "kind");

CREATE TABLE "screenshots" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"       UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  "user_id"         UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "application_id"  UUID NULL REFERENCES "applications"("id") ON DELETE CASCADE,
  "run_id"          UUID NULL REFERENCES "job_runs"("id") ON DELETE SET NULL,
  "platform_id"     UUID NULL REFERENCES "platforms"("id"),
  "kind"            TEXT NOT NULL,
  "uri"             TEXT NOT NULL,
  "redacted"        BOOLEAN NOT NULL DEFAULT false,
  "bytes"           BIGINT,
  "sha256"          BYTEA,
  "captured_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "label"           TEXT
);
CREATE INDEX "screenshots_user_idx" ON "screenshots"("user_id", "captured_at" DESC);
CREATE INDEX "screenshots_application_idx" ON "screenshots"("application_id");

-- =============================================================================
-- EVENT LOGS (append-only; partition-ready via composite PK)
-- =============================================================================

CREATE TABLE "run_events" (
  "id"            BIGSERIAL,
  "tenant_id"     UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  "run_id"        UUID NOT NULL,
  "user_id"       UUID NOT NULL,
  "occurred_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "kind"          TEXT NOT NULL,
  "payload"       JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY ("id", "occurred_at")
);
CREATE INDEX "run_events_run_idx" ON "run_events"("run_id", "occurred_at");
CREATE INDEX "run_events_user_idx" ON "run_events"("user_id", "occurred_at");

CREATE TABLE "application_events" (
  "id"              BIGSERIAL,
  "tenant_id"       UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  "application_id"  UUID NOT NULL,
  "user_id"         UUID NOT NULL,
  "occurred_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "kind"            TEXT NOT NULL,
  "payload"         JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY ("id", "occurred_at")
);
CREATE INDEX "application_events_app_idx" ON "application_events"("application_id", "occurred_at");
CREATE INDEX "application_events_user_idx" ON "application_events"("user_id", "occurred_at");
