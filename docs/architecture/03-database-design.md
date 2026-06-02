# Phase 3 — Database Design

## 1. Goals

The schema is the contract that outlives every other layer. It must:

- Represent the domain accurately, with foreign keys that reflect real relationships.
- Make every consequential action auditable (applications submitted, AI decisions, profile mutations, security events).
- Survive growth into millions of rows on the hot tables without a rewrite (partitioning hooks built in).
- Hold encrypted columns and KMS key references without leaking key material.
- Power semantic search over the user's knowledge base via `pgvector`.
- Allow the orchestrator to be a single writer to status fields, without lock contention killing throughput.
- Be easy to seed for dev and easy to back up / restore in prod.

## 2. Engine, extensions, and conventions

**Engine:** PostgreSQL 16.

**Extensions:**
| Extension | Purpose |
| --- | --- |
| `pgcrypto` | Random UUIDs (`gen_random_uuid()`), HMAC, digest functions. |
| `pgvector` | Embedding storage and ANN search for Q&A memory and job similarity. |
| `pg_partman` | Time-based partition management for `analytics_events`, `application_events`, `ai_decisions`. |
| `pg_trgm` | Trigram indexes for fuzzy search over job titles, company names, skills. |
| `citext` | Case-insensitive text for emails and platform usernames. |
| `btree_gin`, `btree_gist` | Composite indexes mixing scalar + array columns. |

**Conventions:**
- Surrogate keys: every table has `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`. No natural primary keys; uniqueness is enforced by separate constraints where needed.
- Timestamps: `created_at TIMESTAMPTZ NOT NULL DEFAULT now()` and `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()` on every table that mutates.
- Soft delete: `deleted_at TIMESTAMPTZ NULL` on user-owned tables; default queries filter via partial indexes.
- Tenancy: `user_id UUID NOT NULL` on every row that belongs to a user. We do not yet ship row-level security; the application enforces it. RLS is added in M9 with the multi-tenant rollout.
- Naming: `snake_case` for tables and columns, plural table names, FK columns `<thing>_id`.
- Enums: PostgreSQL native `ENUM`s for closed-set, low-churn fields (status, mode, platform). For evolving sets we use `TEXT CHECK (... IN ...)`.
- JSONB: used only where shape is genuinely open (e.g., raw resume parse output); never as a substitute for proper columns.
- Money: salary expressed as `BIGINT` minor units (e.g., paise, cents) plus `currency CHAR(3)`. No floats for money, ever.

## 3. Logical model overview

Eight domains, each a cluster of tables with hard internal links and well-defined external links.

1. **Identity & access** — `users`, `user_sessions`, `webauthn_credentials`, `totp_secrets`, `mfa_recovery_codes`, `roles`, `user_roles`, `permissions`, `user_permissions`.
2. **Profile knowledge base** — `user_profiles`, `personal_info`, `educations`, `work_experiences`, `projects`, `skills`, `user_skills`, `links` (github/portfolio/etc.), `frequent_answers`, `qa_memory`, `embeddings`.
3. **Resumes** — `resumes`, `resume_versions`, `resume_files` (object storage refs), `resume_permissions`.
4. **Platforms & credentials** — `platforms` (static), `platform_accounts`, `platform_credentials` (envelope-encrypted), `platform_permissions`, `platform_sessions` (Playwright storage state references).
5. **Discovery & jobs** — `jobs`, `job_skills`, `job_search_filters`, `job_seen` (per user dedupe).
6. **Runs & applications** — `job_runs`, `run_stages`, `applications`, `application_questions`, `application_files`, `run_events`, `application_events`.
7. **AI decisions & cost** — `ai_models`, `ai_prompts`, `ai_decisions`, `ai_cost_ledger`, `ai_eval_results`.
8. **Audit & analytics** — `audit_log` (hash-chained), `security_events`, `analytics_events` (partitioned), `analytics_rollups`, `notifications`.

## 4. Schema (`schema.prisma` + raw SQL extensions)

The Prisma schema is the canonical source. Raw SQL migrations cover what Prisma cannot express: extensions, partitioning, RLS hooks (later), trigram indexes, generated columns, hash-chain triggers.

The full schema is long; this section gives the **definitive shape** of every table. The actual `schema.prisma` is generated from this in M0.

### 4.1 Identity & access

```sql
CREATE TYPE user_status AS ENUM ('active', 'suspended', 'deleted');

CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           CITEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL,
  password_hash   TEXT NOT NULL,                 -- argon2id; rotated on policy change
  status          user_status NOT NULL DEFAULT 'active',
  data_key_id     TEXT NOT NULL,                 -- Vault key id used to wrap this user's DEK
  data_key_wrapped BYTEA NOT NULL,               -- ciphertext of the per-user DEK
  email_verified_at TIMESTAMPTZ NULL,
  last_login_at   TIMESTAMPTZ NULL,
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ NULL
);
CREATE INDEX users_active_idx ON users(id) WHERE deleted_at IS NULL;

CREATE TABLE user_sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash     BYTEA NOT NULL,                 -- SHA-256(session_id_secret)
  user_agent     TEXT,
  ip_inet        INET,
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX user_sessions_user_idx ON user_sessions(user_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX user_sessions_token_idx ON user_sessions(token_hash);

CREATE TABLE webauthn_credentials (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id  BYTEA NOT NULL UNIQUE,
  public_key     BYTEA NOT NULL,
  sign_count     BIGINT NOT NULL DEFAULT 0,
  transports     TEXT[],
  device_label   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ NULL
);

CREATE TABLE totp_secrets (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_wrapped BYTEA NOT NULL,                 -- wrapped with user DEK
  enabled_at     TIMESTAMPTZ NULL,
  last_used_at   TIMESTAMPTZ NULL
);

CREATE TABLE mfa_recovery_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   BYTEA NOT NULL,                   -- argon2id(code)
  used_at     TIMESTAMPTZ NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key   TEXT NOT NULL UNIQUE,                   -- 'owner','viewer','automation_bot'
  label TEXT NOT NULL
);

CREATE TABLE user_roles (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE permissions (
  id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key   TEXT NOT NULL UNIQUE,                  -- 'profile.edit', 'resume.edit.global', 'resume.edit.linkedin', ...
  label TEXT NOT NULL
);

CREATE TABLE user_permissions (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE RESTRICT,
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by   UUID NULL REFERENCES users(id),
  scope        JSONB NOT NULL DEFAULT '{}'::jsonb,   -- e.g., { "platform": "linkedin" }
  PRIMARY KEY (user_id, permission_id, scope)
);
```

### 4.2 Profile knowledge base

```sql
CREATE TABLE user_profiles (
  user_id           UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  headline          TEXT,
  summary           TEXT,
  current_title     TEXT,
  current_company   TEXT,
  total_experience_months INTEGER,
  notice_period_days INTEGER,
  willing_to_relocate BOOLEAN,
  preferred_currency CHAR(3),
  expected_salary_min BIGINT,    -- minor units
  expected_salary_max BIGINT,
  preferred_locations TEXT[],    -- normalized city names
  preferred_remote   TEXT CHECK (preferred_remote IN ('remote','hybrid','onsite','any')),
  preferred_employment_types TEXT[] CHECK (preferred_employment_types <@ ARRAY['full_time','part_time','contract','internship','freelance']),
  raw_parse         JSONB,        -- last resume parse output, schema-versioned
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE personal_info (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  legal_first_name TEXT,
  legal_last_name TEXT,
  date_of_birth_enc BYTEA,         -- AES-GCM(nonce || ct), wrapped via user DEK
  phone_e164_enc  BYTEA,           -- same
  address_enc     BYTEA,           -- same
  nationality     TEXT,
  work_authorization JSONB,        -- per country: { "US": {"status":"citizen"}, "IN": {...} }
  visa_status     TEXT,
  gender          TEXT,
  ethnicity       TEXT,            -- US EEOC; only filled if user provides
  veteran_status  TEXT,
  disability_status TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE educations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  institution TEXT NOT NULL,
  degree      TEXT,
  field_of_study TEXT,
  start_date  DATE,
  end_date    DATE,                 -- NULL = ongoing
  grade       TEXT,
  description TEXT,
  ordinal     INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX educations_user_idx ON educations(user_id, ordinal);

CREATE TABLE work_experiences (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company     TEXT NOT NULL,
  title       TEXT NOT NULL,
  location    TEXT,
  employment_type TEXT,
  start_date  DATE NOT NULL,
  end_date    DATE,
  is_current  BOOLEAN NOT NULL DEFAULT false,
  description TEXT,                  -- bullet list, markdown allowed
  achievements JSONB,                -- structured bullets w/ metrics
  ordinal     INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX work_experiences_user_idx ON work_experiences(user_id, ordinal);

CREATE TABLE projects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  url         TEXT,
  repo_url    TEXT,
  tech_stack  TEXT[],
  start_date  DATE,
  end_date    DATE,
  ordinal     INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE skills (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name      CITEXT NOT NULL UNIQUE,
  canonical TEXT NOT NULL,            -- normalized form for matching
  category  TEXT
);
CREATE INDEX skills_trgm_idx ON skills USING gin (canonical gin_trgm_ops);

CREATE TABLE user_skills (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_id    UUID NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  proficiency SMALLINT CHECK (proficiency BETWEEN 1 AND 5),
  years       NUMERIC(4,1),
  is_primary  BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, skill_id)
);

CREATE TABLE links (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL,            -- 'github','linkedin','portfolio','twitter','other'
  url       TEXT NOT NULL,
  label     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE frequent_answers (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prompt    TEXT NOT NULL,
  answer    TEXT NOT NULL,
  category  TEXT,                    -- 'work_auth','salary','relocation','notice','behavioral'
  is_locked BOOLEAN NOT NULL DEFAULT false, -- when true, AI cannot rewrite
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE qa_memory (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_norm   TEXT NOT NULL,        -- normalized canonical phrasing
  question_raw    TEXT NOT NULL,        -- as seen on the platform
  answer          TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('user','ai_generated','user_corrected')),
  platform_id     UUID NULL REFERENCES platforms(id),
  application_id  UUID NULL,            -- FK added later via ALTER (cyclic)
  used_count      INTEGER NOT NULL DEFAULT 0,
  last_used_at    TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX qa_memory_user_norm_idx ON qa_memory(user_id, question_norm);

CREATE TABLE embeddings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_kind  TEXT NOT NULL CHECK (owner_kind IN ('qa_memory','frequent_answer','project','experience','skill','resume_version','job')),
  owner_id    UUID NOT NULL,
  model       TEXT NOT NULL,             -- e.g., 'voyage-2', 'text-embedding-3-large'
  dim         INTEGER NOT NULL,
  vector      vector(1024) NOT NULL,    -- adjust dim per model in migration
  text_hash   BYTEA NOT NULL,            -- SHA-256(input text) for dedupe
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX embeddings_user_owner_idx ON embeddings(user_id, owner_kind, owner_id);
CREATE INDEX embeddings_ann_idx ON embeddings USING ivfflat (vector vector_cosine_ops) WITH (lists = 100);
```

### 4.3 Resumes

```sql
CREATE TABLE resumes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  is_default   BOOLEAN NOT NULL DEFAULT false,
  current_version_id UUID NULL,         -- FK to resume_versions, set after first version
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ NULL
);
CREATE UNIQUE INDEX resumes_user_default_idx ON resumes(user_id) WHERE is_default = true AND deleted_at IS NULL;

CREATE TABLE resume_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resume_id     UUID NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id     UUID NULL REFERENCES resume_versions(id),
  version_no    INTEGER NOT NULL,           -- 1-based, monotonically increasing per resume
  source        TEXT NOT NULL CHECK (source IN ('uploaded','ai_tailored','user_edited')),
  notes         TEXT,                       -- human-visible "why this version exists"
  parsed        JSONB NOT NULL,             -- structured: sections, bullets, metrics
  hash          BYTEA NOT NULL,             -- SHA-256(canonical JSON)
  approved_by   UUID NULL REFERENCES users(id),
  approved_at   TIMESTAMPTZ NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX resume_versions_resume_no_idx ON resume_versions(resume_id, version_no);

CREATE TABLE resume_files (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id  UUID NOT NULL REFERENCES resume_versions(id) ON DELETE CASCADE,
  format      TEXT NOT NULL CHECK (format IN ('pdf','docx','txt')),
  uri         TEXT NOT NULL,                 -- s3://bucket/key
  bytes       BIGINT NOT NULL,
  sha256      BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX resume_files_version_format_idx ON resume_files(version_id, format);

CREATE TABLE resume_permissions (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope       TEXT NOT NULL,                 -- 'global' or platform key
  allow_edit  BOOLEAN NOT NULL DEFAULT false,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope)
);
```

### 4.4 Platforms & credentials

```sql
CREATE TABLE platforms (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key       TEXT NOT NULL UNIQUE,            -- 'linkedin','naukri','indeed',...
  label     TEXT NOT NULL,
  base_url  TEXT NOT NULL,
  enabled   BOOLEAN NOT NULL DEFAULT true,
  ordinal   SMALLINT NOT NULL                 -- canonical multi-platform sequence
);

CREATE TABLE platform_accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform_id   UUID NOT NULL REFERENCES platforms(id) ON DELETE RESTRICT,
  display_label TEXT,
  username_enc  BYTEA,                       -- encrypted with user DEK
  status        TEXT NOT NULL CHECK (status IN ('connected','disconnected','expired','blocked')),
  last_login_at TIMESTAMPTZ NULL,
  last_session_check_at TIMESTAMPTZ NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, platform_id)
);

CREATE TABLE platform_credentials (
  account_id     UUID PRIMARY KEY REFERENCES platform_accounts(id) ON DELETE CASCADE,
  cipher         BYTEA NOT NULL,              -- AES-GCM(nonce || ct) of secret payload
  cipher_aad     BYTEA NOT NULL,              -- AAD: account_id || version
  vault_key_id   TEXT NOT NULL,               -- key alias used to wrap the DEK
  rotation_version INTEGER NOT NULL DEFAULT 1,
  rotated_at     TIMESTAMPTZ NULL,
  expires_at     TIMESTAMPTZ NULL,            -- when password change is mandatory
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE platform_permissions (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform_id   UUID NOT NULL REFERENCES platforms(id) ON DELETE RESTRICT,
  allow_apply   BOOLEAN NOT NULL DEFAULT true,
  allow_profile_edit BOOLEAN NOT NULL DEFAULT false,
  allow_resume_edit  BOOLEAN NOT NULL DEFAULT false,
  autonomous_mode    TEXT NOT NULL CHECK (autonomous_mode IN ('assisted','autonomous')) DEFAULT 'assisted',
  daily_application_cap INTEGER,
  threshold_score    SMALLINT NOT NULL DEFAULT 70,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, platform_id)
);

CREATE TABLE platform_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  storage_uri   TEXT NOT NULL,                -- s3://...; encrypted at rest
  expires_at    TIMESTAMPTZ,
  health        TEXT NOT NULL CHECK (health IN ('fresh','stale','blocked','unknown')),
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 4.5 Discovery & jobs

```sql
CREATE TYPE freshness_tier AS ENUM ('t5h','t12h','t24h','t5d','stale');

CREATE TABLE jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_id     UUID NOT NULL REFERENCES platforms(id),
  external_id     TEXT NOT NULL,               -- platform's job id
  url             TEXT NOT NULL,
  title           TEXT NOT NULL,
  company         TEXT,
  location        TEXT,
  remote_kind     TEXT,
  posted_at       TIMESTAMPTZ,                 -- best-effort
  discovered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  freshness       freshness_tier,              -- recomputed on each consideration
  description_md  TEXT,
  raw             JSONB,                       -- raw API/parse payload
  applicants      INTEGER,
  salary_min      BIGINT,
  salary_max      BIGINT,
  currency        CHAR(3),
  is_quick_apply  BOOLEAN,
  required_skills TEXT[],
  embedding_id    UUID NULL REFERENCES embeddings(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform_id, external_id)
);
CREATE INDEX jobs_platform_posted_idx ON jobs(platform_id, posted_at DESC);
CREATE INDEX jobs_title_trgm_idx ON jobs USING gin (title gin_trgm_ops);

CREATE TABLE job_skills (
  job_id   UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  skill_id UUID NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  PRIMARY KEY (job_id, skill_id)
);

CREATE TABLE job_search_filters (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  platform_id UUID NULL REFERENCES platforms(id),
  query       TEXT,
  locations   TEXT[],
  remote_kinds TEXT[],
  min_salary  BIGINT,
  currency    CHAR(3),
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE job_seen (                     -- per-user dedupe so we don't re-apply
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id    UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, job_id)
);
```

### 4.6 Runs & applications

```sql
CREATE TYPE run_mode AS ENUM ('single','multi');
CREATE TYPE run_status AS ENUM ('pending','planning','running','paused','stopped','done','failed');
CREATE TYPE stage_status AS ENUM ('pending','discovering','applying','done','skipped','failed');
CREATE TYPE application_status AS ENUM (
  'queued','submitting','submitted','viewed','shortlisted',
  'rejected','interview_scheduled','offer','withdrawn',
  'skipped_human_required','skipped_low_score','skipped_stale',
  'failed_selector_drift','failed_platform_error','duplicate'
);

CREATE TABLE job_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode            run_mode NOT NULL,
  status          run_status NOT NULL DEFAULT 'pending',
  control         TEXT NOT NULL DEFAULT 'run' CHECK (control IN ('run','pause','stop')),
  target_per_platform INTEGER NOT NULL DEFAULT 20,
  threshold_score SMALLINT NOT NULL DEFAULT 70,
  autonomous      BOOLEAN NOT NULL DEFAULT false,
  requested_platforms UUID[] NOT NULL,        -- order matters for multi
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  idempotency_key TEXT NOT NULL,
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX job_runs_user_status_idx ON job_runs(user_id, status);

CREATE TABLE run_stages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       UUID NOT NULL REFERENCES job_runs(id) ON DELETE CASCADE,
  platform_id  UUID NOT NULL REFERENCES platforms(id),
  ordinal      SMALLINT NOT NULL,             -- order within run
  status       stage_status NOT NULL DEFAULT 'pending',
  target       INTEGER NOT NULL,
  applied_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  failed_count  INTEGER NOT NULL DEFAULT 0,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  reason        TEXT,                          -- 'no_account','platform_disabled','quota_reached','user_stop'
  UNIQUE (run_id, platform_id),
  UNIQUE (run_id, ordinal)
);

CREATE TABLE applications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id        UUID NULL REFERENCES job_runs(id) ON DELETE SET NULL,
  stage_id      UUID NULL REFERENCES run_stages(id) ON DELETE SET NULL,
  job_id        UUID NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  platform_id   UUID NOT NULL REFERENCES platforms(id),
  status        application_status NOT NULL,
  ai_score      SMALLINT,
  resume_version_id UUID NULL REFERENCES resume_versions(id),
  cover_letter_id   UUID NULL,                  -- generated artifact ref
  freshness_at_apply freshness_tier,
  submitted_at  TIMESTAMPTZ,
  outcome_at    TIMESTAMPTZ,                    -- last status change
  reason        TEXT,                           -- skip/fail reasoning
  external_application_id TEXT,                 -- platform's id if any
  idempotency_key TEXT NOT NULL,                -- 'apply:{run_id}:{stage_id}:{job_id}'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, job_id),                     -- never apply twice to same job
  UNIQUE (idempotency_key)
);
-- AUDIT CORRECTION (A1, S1): the hard `UNIQUE (user_id, job_id)` above is SUPERSEDED
-- by a partial unique index that excludes failed/skipped/duplicate statuses, so a
-- legitimate retry after a transient failure is not permanently blocked. The
-- `UNIQUE (idempotency_key)` guard is retained. See docs/audit/05-database-additions.md §1.1.
CREATE INDEX applications_user_status_idx ON applications(user_id, status, submitted_at DESC);
CREATE INDEX applications_run_idx ON applications(run_id);

ALTER TABLE qa_memory
  ADD CONSTRAINT qa_memory_application_fk
  FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE SET NULL;

CREATE TABLE application_questions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  question_raw   TEXT NOT NULL,
  question_norm  TEXT NOT NULL,
  field_kind     TEXT NOT NULL,                -- 'text','select','radio','checkbox','file','date','number'
  answer         TEXT,
  source         TEXT NOT NULL CHECK (source IN ('frequent_answer','qa_memory','ai_generated','user_intervention')),
  ai_decision_id UUID NULL,                    -- references ai_decisions
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX application_questions_app_idx ON application_questions(application_id);

CREATE TABLE application_files (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('resume','cover_letter','screenshot','dom_snapshot','attachment')),
  uri            TEXT NOT NULL,
  step_label     TEXT,
  bytes          BIGINT,
  sha256         BYTEA,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX application_files_app_idx ON application_files(application_id, kind);

CREATE TABLE run_events (                      -- partitioned (see §7)
  id          BIGSERIAL,
  run_id      UUID NOT NULL,
  user_id     UUID NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind        TEXT NOT NULL,                   -- 'planned','stage.started','stage.done','paused','resumed','stopped','failed'
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE application_events (              -- partitioned
  id              BIGSERIAL,
  application_id  UUID NOT NULL,
  user_id         UUID NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind            TEXT NOT NULL,               -- 'queued','opened','filled','question_answered','submitted','status_changed','screenshot','captcha_detected','skipped','failed'
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
```

### 4.7 AI decisions & cost

```sql
CREATE TABLE ai_models (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider  TEXT NOT NULL,
  name      TEXT NOT NULL,                  -- 'claude-opus-4','claude-sonnet-4',...
  tier      TEXT NOT NULL CHECK (tier IN ('reason','default','fast','embed')),
  context_window INTEGER,
  unit_cost_in_per_1k NUMERIC(10,6),
  unit_cost_out_per_1k NUMERIC(10,6),
  enabled   BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (provider, name)
);

CREATE TABLE ai_prompts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key           TEXT NOT NULL,              -- 'job.relevance','app.answer','resume.tailor','profile.review','cover.letter'
  version       INTEGER NOT NULL,
  template      TEXT NOT NULL,
  output_schema JSONB NOT NULL,             -- JSON schema (Zod-derived)
  notes         TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (key, version)
);

CREATE TABLE ai_decisions (                  -- partitioned
  id           BIGSERIAL,
  user_id      UUID NOT NULL,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  prompt_key   TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  model_name   TEXT NOT NULL,
  inputs       JSONB NOT NULL,              -- redacted-on-write of PII when applicable
  output       JSONB NOT NULL,
  reasoning    TEXT,                         -- one-paragraph summary
  scope_kind   TEXT NOT NULL,                -- 'job_score','app_question','resume_tailor','profile_review','cover_letter'
  scope_id     UUID,                         -- e.g., job_id, application_id, resume_version_id
  tokens_in    INTEGER NOT NULL,
  tokens_out   INTEGER NOT NULL,
  cost_usd     NUMERIC(10,6) NOT NULL,
  duration_ms  INTEGER NOT NULL,
  trace_id     TEXT,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE ai_cost_ledger (
  user_id      UUID NOT NULL,
  day          DATE NOT NULL,
  tokens_in    BIGINT NOT NULL DEFAULT 0,
  tokens_out   BIGINT NOT NULL DEFAULT 0,
  cost_usd     NUMERIC(12,6) NOT NULL DEFAULT 0,
  by_tier      JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE ai_eval_results (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_key   TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  model_name   TEXT NOT NULL,
  dataset      TEXT NOT NULL,
  pass_rate    NUMERIC(5,4) NOT NULL,
  metrics      JSONB NOT NULL,
  ran_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 4.8 Audit & analytics

```sql
CREATE TABLE audit_log (
  id           BIGSERIAL PRIMARY KEY,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('user','system','ai','automation_bot')),
  actor_id     UUID,
  user_id      UUID,                          -- subject
  action       TEXT NOT NULL,                 -- 'profile.update','resume.create','permission.grant','run.start','credentials.read'
  target_kind  TEXT,
  target_id    UUID,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  prev_hash    BYTEA,                         -- hash chain
  hash         BYTEA NOT NULL,                -- SHA-256(prev_hash || canonical(row-without-hash))
  ip_inet      INET,
  user_agent   TEXT
);
CREATE INDEX audit_log_user_idx ON audit_log(user_id, occurred_at DESC);
CREATE INDEX audit_log_action_idx ON audit_log(action, occurred_at DESC);

CREATE TABLE security_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id      UUID,
  kind         TEXT NOT NULL,                 -- 'login.failed','mfa.enrolled','session.revoked','captcha.encountered','rate_limit.hit'
  severity     TEXT NOT NULL CHECK (severity IN ('info','warn','high','critical')),
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_inet      INET,
  user_agent   TEXT
);
CREATE INDEX security_events_user_idx ON security_events(user_id, occurred_at DESC);

CREATE TABLE analytics_events (                -- partitioned
  id           BIGSERIAL,
  user_id      UUID NOT NULL,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind         TEXT NOT NULL,                 -- 'app.submitted','app.viewed','app.shortlisted','app.rejected','app.interview','app.offer','run.started','run.finished'
  platform_id  UUID,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE analytics_rollups (
  user_id      UUID NOT NULL,
  bucket       TEXT NOT NULL CHECK (bucket IN ('day','week','month')),
  bucket_start DATE NOT NULL,
  platform_id  UUID,                           -- NULL = all platforms
  applied      INTEGER NOT NULL DEFAULT 0,
  viewed       INTEGER NOT NULL DEFAULT 0,
  shortlisted  INTEGER NOT NULL DEFAULT 0,
  rejected     INTEGER NOT NULL DEFAULT 0,
  interviewed  INTEGER NOT NULL DEFAULT 0,
  offered      INTEGER NOT NULL DEFAULT 0,
  response_rate NUMERIC(5,4),
  conversion_rate NUMERIC(5,4),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bucket, bucket_start, platform_id)
);

CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                   -- 'run.paused','captcha','profile.suggestion','offer.received'
  channel     TEXT NOT NULL CHECK (channel IN ('inapp','email','push','webhook')),
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  delivered_at TIMESTAMPTZ,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;
```

## 5. Key invariants enforced in the database

The database is the last line of defense. Application code is fast; database constraints are correct.

| Invariant | Mechanism |
| --- | --- |
| Never apply twice for the same job | Partial unique index on `applications(user_id, job_id) WHERE status NOT IN (failed/skipped/duplicate)` — **supersedes** the hard `UNIQUE (user_id, job_id)` (audit A1, S1; see docs/audit/05-database-additions.md §1.1). Allows retry after transient failure while preventing duplicate live applications. |
| Idempotent retries | `UNIQUE (idempotency_key)` on `applications` and `job_runs`. |
| At most one default resume per user | Partial unique index `WHERE is_default = true AND deleted_at IS NULL`. |
| Resume version chain monotonic | `UNIQUE (resume_id, version_no)` and trigger ensures `parent_id` belongs to same `resume_id`. |
| Stage order stable in run | `UNIQUE (run_id, ordinal)`. |
| One platform account per user/platform | `UNIQUE (user_id, platform_id)` on `platform_accounts`. |
| AI decision belongs to a known prompt version | FK `ai_decisions.(prompt_key, prompt_version)` → `ai_prompts`. *Implemented as a composite check via trigger because Prisma can't express composite FKs cleanly across partitioned tables.* |
| Permission scope JSON well-formed | `jsonb_typeof(scope) = 'object'` CHECK; deeper validation at API layer. |
| Audit hash chain unbroken | BEFORE INSERT trigger sets `prev_hash` from latest `hash` and computes new hash; raises on tampering attempts (UPDATE/DELETE). |

## 6. Encryption-at-the-row level

The crypto package (Phase 8) defines two write paths into the DB:

1. **Wrapped DEK columns** (`users.data_key_wrapped`, `platform_credentials.cipher`, `personal_info.*_enc`, etc.) are written by application code; DB stores ciphertext only.
2. **Object-storage payloads** (resume files, screenshots) are server-side encrypted by S3 with our KMS key, and the URI is stored in PG.

The DB never sees plaintext PII. Even superuser `pg_dump` snapshots are useless without the KMS key.

`pg_audit` is enabled in production for SELECT statements that touch `personal_info`, `platform_credentials`, and `qa_memory`. Read-of-secret events flow into `audit_log`.

## 7. Partitioning strategy

Hot, append-mostly tables are time-partitioned via `pg_partman`. They are never updated; they are only inserted, then aged out.

| Table | Partition key | Period | Retention | Index strategy |
| --- | --- | --- | --- | --- |
| `analytics_events` | `occurred_at` | monthly | 24 months hot, archive to S3 thereafter | `(user_id, occurred_at)` per partition |
| `application_events` | `occurred_at` | monthly | 24 months | `(application_id, occurred_at)` per partition |
| `run_events` | `occurred_at` | monthly | 24 months | `(run_id, occurred_at)` per partition |
| `ai_decisions` | `occurred_at` | weekly | 13 weeks online, then archive | `(user_id, occurred_at)`, `(prompt_key, occurred_at)` |

Beyond this, when concurrent active users exceed ~50k, we hash-partition `applications` and `qa_memory` by `user_id`. The schema is ready for it: every row already carries `user_id`.

## 8. Indexing philosophy

Indexes are designed against actual query patterns, not "in case." Each index has a documented query in `docs/db/indexes.md` (added in M0).

Highlights:
- `applications(user_id, status, submitted_at DESC)` — powers the dashboard pipeline view.
- `applications(run_id)` — run progress queries.
- `jobs(platform_id, posted_at DESC)` — discovery freshness queries.
- `embeddings USING ivfflat(vector vector_cosine_ops)` — Q&A memory recall.
- Trigram indexes on `skills.canonical` and `jobs.title` — fuzzy match without LIKE %text%.
- Partial unique index on `resumes` for the "default resume" rule.
- Partial index `users(id) WHERE deleted_at IS NULL` to make active-user queries cheap.

## 9. Search & vector strategy

Two search modes coexist:

1. **Lexical/structured** — Postgres full-text on `jobs.description_md` (`tsvector` generated column), trigram on titles, and exact filters on platform/location.
2. **Semantic** — `pgvector` IVFFlat index. Embedding model is registered in `embeddings.model` so we can roll forward. Re-embed on model change is an offline job that respects the cost ledger.

When matching a user's question to prior `qa_memory`, we combine: trigram similarity ≥ 0.6 OR cosine distance ≤ 0.25, sorted by `last_used_at DESC, used_count DESC`. The blend has held up in eval against pure-vector and pure-lex baselines.

## 10. Migrations & seed

- Prisma Migrate produces forward-only migrations. Each migration's SQL is reviewed in PR.
- Extension/partition/trigger DDL lives in `prisma/migrations/<id>/migration.sql` appended after the auto-generated portion, with a comment `-- raw: <description>`.
- `prisma migrate deploy` runs in production exactly once per release; safety: the deploy step refuses to run if any migration's checksum drifts.
- Seed (`prisma/seed.ts`) is idempotent and seeds only static reference data: `platforms`, `roles`, `permissions`, `ai_models`, `ai_prompts` (active versions). Seed never inserts user data.

## 11. Backup, restore, and disaster recovery

- **Continuous backups:** WAL archived to S3 every 60 seconds (`wal-g` or managed equivalent).
- **Daily logical dumps:** `pg_dump` (custom format) of all schemas, encrypted client-side with a backup key (separate from the data KMS key), retained 30 days online + 1 year cold.
- **PITR target:** 60 seconds.
- **RTO target:** 30 minutes for prod, scripted via `infra/scripts/db-restore.sh`.
- **Quarterly drills:** restore staging from a prod snapshot; sign-off ticket required.
- **Object storage:** versioned bucket; lifecycle to glacier after 90 days for screenshots; 1-year retention for resume files; 7-year retention for application files of submitted applications (audit need).

## 12. Performance considerations (DB layer)

- Connection pooling via PgBouncer (transaction mode) for the API and orchestrator. The AI service uses session mode because of `SET LOCAL` for tracing.
- Prepared statement caching is enabled by default; Prisma's connection mode is set to keep prepared statements pinned per connection.
- Heavy reads (analytics dashboards) hit a hot read replica. Writes go to primary; the orchestrator reads its own writes from primary.
- Long-running maintenance (REINDEX, partition detach) is scheduled in low-traffic windows by `pg_cron`.
- The IVFFlat index uses `lists = sqrt(N)` heuristic; we re-index quarterly or after a 30% row-count delta.
- All DB calls are traced via OpenTelemetry; queries above 200 ms p95 land on a weekly review board.

## 13. Security implications (DB layer)

- Plaintext PII never lands in `audit_log` or `ai_decisions.inputs`; redaction utilities in `packages/shared-logger` strip known keys (`phone`, `address`, `dob`, `credentials.*`) before write.
- `ai_decisions.inputs` carries hashed handles where direct values would be sensitive (e.g., `phone_hash` instead of phone).
- Database roles:
  - `apex_app` — read/write on app tables; no `audit_log` UPDATE/DELETE.
  - `apex_audit_writer` — INSERT-only on `audit_log`.
  - `apex_readonly` — analytics dashboards.
  - `apex_owner` — migrations only; rotated frequently.
- Row-Level Security: enabled in M9 with `tenant_id`. Until then, the application enforces `WHERE user_id = $session.user_id` via repository helpers; ESLint rule blocks raw queries that omit it (`apex/no-direct-prisma-in-apps`).

## 14. Tradeoffs accepted

- **Single primary DB.** Operational simplicity > distributed-data correctness puzzles. Path to partitioning is built in.
- **JSONB for `raw` payloads.** We sacrifice strict typing for resilience to upstream parser churn. Validated Zod schemas live one layer above.
- **pgvector over a dedicated vector DB.** One fewer system to operate. We pay for IVFFlat's recall tradeoff; eval shows it is acceptable for our scale.
- **Hash-chain audit instead of an append-only ledger DB.** Cheap, sufficient, verifiable; we do not need a blockchain.
- **Soft delete by default for user data.** Lets users recover; complicates queries (always filter). The partial indexes pay for themselves.
- **`personal_info` columns are `BYTEA` not separate vault references.** Faster reads, fewer cross-system trips. Each column is sealed individually so a leaked row reveals only one user, not the keystore.

## 15. What this phase deliberately does not decide

- Specific Prisma model attributes (relations, default selectors) — that lands with the code in M0.
- Exact embedding model (`voyage-2` vs `text-embedding-3-large`) — Phase 7 decides per cost/accuracy tradeoff and the schema absorbs it via `embeddings.model`.
- Exact partition cron windows — Phase 9.
- Multi-region replication — out of scope until M9.
