-- Phase 3 — AI engine schema.
--
-- References: docs/architecture/07-ai-engine.md §4–§14;
--             docs/audit/05-database-additions.md (A2 per-dim embeddings,
--             B1 atomic cost ledger, D3 qa quarantine, A6 dek_version).
--
-- Forward-only. The DDL below is the Prisma-generated portion for the new
-- models, followed by `-- raw:` blocks that add what Prisma cannot express:
-- the pgvector `vector` columns, the HNSW/IVFFlat ANN indexes, the unified
-- `embeddings` read view, and the atomic cost-debit function (audit B1).
--
-- Rollback: see the `-- DOWN` block at the end (apply manually if reverting;
-- Prisma migrations are forward-only, so this is documented, not auto-run).

-- Required extensions (idempotent).
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

-- =============================================================================
-- prompt_registry
-- =============================================================================
CREATE TABLE "prompt_registry" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "key"             TEXT NOT NULL,
  "version"         INTEGER NOT NULL,
  "tier"            TEXT NOT NULL,
  "temperature"     DOUBLE PRECISION NOT NULL,
  "max_tokens"      INTEGER NOT NULL,
  "response_format" TEXT NOT NULL,
  "config"          JSONB NOT NULL DEFAULT '{}'::jsonb,
  "is_active"       BOOLEAN NOT NULL DEFAULT false,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "prompt_registry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "prompt_registry_key_version_idx" ON "prompt_registry"("key", "version");
CREATE INDEX "prompt_registry_key_active_idx" ON "prompt_registry"("key", "is_active");

-- =============================================================================
-- ai_decisions  (partitioned weekly in production; plain table here)
-- =============================================================================
CREATE TABLE "ai_decisions" (
  "id"               BIGSERIAL NOT NULL,
  "tenant_id"        UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  "user_id"          UUID NOT NULL,
  "prompt_key"       TEXT NOT NULL,
  "prompt_version"   INTEGER NOT NULL,
  "tier"             TEXT NOT NULL,
  "model"            TEXT NOT NULL,
  "scope_kind"       TEXT NOT NULL,
  "scope_id"         UUID NOT NULL,
  "inputs"           JSONB NOT NULL DEFAULT '{}'::jsonb,
  "output"           JSONB NOT NULL DEFAULT '{}'::jsonb,
  "validation_error" TEXT,
  "governor_action"  TEXT,
  "safety_score"     NUMERIC(4,3),
  "safety_action"    TEXT,
  "cost_usd"         NUMERIC(12,6) NOT NULL DEFAULT 0,
  "input_tokens"     INTEGER NOT NULL DEFAULT 0,
  "output_tokens"    INTEGER NOT NULL DEFAULT 0,
  "latency_ms"       INTEGER NOT NULL DEFAULT 0,
  "trace_id"         TEXT,
  "occurred_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "ai_decisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_decisions_governor_action_chk" CHECK ("governor_action" IS NULL OR "governor_action" IN ('pass','downgrade','skip')),
  CONSTRAINT "ai_decisions_safety_action_chk" CHECK ("safety_action" IS NULL OR "safety_action" IN ('passed','redacted','blocked'))
);
CREATE INDEX "ai_decisions_user_idx" ON "ai_decisions"("user_id", "occurred_at" DESC);
CREATE INDEX "ai_decisions_scope_idx" ON "ai_decisions"("scope_kind", "scope_id");
CREATE INDEX "ai_decisions_prompt_idx" ON "ai_decisions"("prompt_key", "prompt_version");

-- =============================================================================
-- ai_cost_ledger
-- =============================================================================
CREATE TABLE "ai_cost_ledger" (
  "user_id"     UUID NOT NULL,
  "tenant_id"   UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  "day"         DATE NOT NULL,
  "spent_usd"   NUMERIC(12,6) NOT NULL DEFAULT 0,
  "ceiling_usd" NUMERIC(12,6) NOT NULL DEFAULT 0,
  "calls"       INTEGER NOT NULL DEFAULT 0,
  "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "ai_cost_ledger_pkey" PRIMARY KEY ("user_id", "day"),
  CONSTRAINT "ai_cost_ledger_nonneg_chk" CHECK ("spent_usd" >= 0)
);
CREATE INDEX "ai_cost_ledger_tenant_day_idx" ON "ai_cost_ledger"("tenant_id", "day");

-- =============================================================================
-- qa_memory  (answer_enc is AES-GCM under the user DEK; dek_version per A6)
-- =============================================================================
CREATE TABLE "qa_memory" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id"        UUID NOT NULL,
  "tenant_id"      UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  "question_norm"  TEXT NOT NULL,
  "answer_enc"     BYTEA NOT NULL,
  "dek_version"    SMALLINT NOT NULL DEFAULT 1,
  "field_kind"     TEXT NOT NULL,
  "used_count"     INTEGER NOT NULL DEFAULT 0,
  "is_locked"      BOOLEAN NOT NULL DEFAULT false,
  "quarantined"    BOOLEAN NOT NULL DEFAULT false,
  "application_id" UUID,
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "qa_memory_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "qa_memory_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "qa_memory_user_question_idx" ON "qa_memory"("user_id", "question_norm");
CREATE INDEX "qa_memory_user_used_idx" ON "qa_memory"("user_id", "used_count" DESC);
-- raw: fuzzy lexical recall on question_norm (pg_trgm).
CREATE INDEX "qa_memory_question_trgm_idx" ON "qa_memory" USING gin ("question_norm" gin_trgm_ops);

-- =============================================================================
-- frequent_answers
-- =============================================================================
CREATE TABLE "frequent_answers" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id"     UUID NOT NULL,
  "tenant_id"   UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  "label"       TEXT NOT NULL,
  "value_enc"   BYTEA NOT NULL,
  "dek_version" SMALLINT NOT NULL DEFAULT 1,
  "is_locked"   BOOLEAN NOT NULL DEFAULT true,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "frequent_answers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "frequent_answers_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "frequent_answers_user_label_idx" ON "frequent_answers"("user_id", "label");

-- =============================================================================
-- answer_history  (append-only; redacted values only)
-- =============================================================================
CREATE TABLE "answer_history" (
  "id"             BIGSERIAL NOT NULL,
  "user_id"        UUID NOT NULL,
  "tenant_id"      UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  "application_id" UUID,
  "question_norm"  TEXT NOT NULL,
  "source"         TEXT NOT NULL,
  "ai_decision_id" BIGINT,
  "value_redacted" TEXT NOT NULL,
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "answer_history_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "answer_history_source_chk" CHECK ("source" IN ('frequent_answer','qa_memory','ai_generated','user_intervention'))
);
CREATE INDEX "answer_history_user_idx" ON "answer_history"("user_id", "created_at" DESC);
CREATE INDEX "answer_history_app_idx" ON "answer_history"("application_id");

-- =============================================================================
-- embeddings_1024 / embeddings_3072  (Prisma-modeled columns; vector via raw)
-- =============================================================================
CREATE TABLE "embeddings_1024" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id"    UUID NOT NULL,
  "tenant_id"  UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  "owner_kind" TEXT NOT NULL,
  "owner_id"   UUID NOT NULL,
  "model"      TEXT NOT NULL,
  "text_hash"  BYTEA NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "embeddings_1024_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "embeddings_1024_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "embeddings_1024_owner_chk" CHECK ("owner_kind" IN ('qa_memory','frequent_answer','project','experience','skill','resume_version','job'))
);
CREATE INDEX "embeddings_1024_user_owner_idx" ON "embeddings_1024"("user_id", "owner_kind", "owner_id");

CREATE TABLE "embeddings_3072" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id"    UUID NOT NULL,
  "tenant_id"  UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  "owner_kind" TEXT NOT NULL,
  "owner_id"   UUID NOT NULL,
  "model"      TEXT NOT NULL,
  "text_hash"  BYTEA NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "embeddings_3072_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "embeddings_3072_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "embeddings_3072_owner_chk" CHECK ("owner_kind" IN ('qa_memory','frequent_answer','project','experience','skill','resume_version','job'))
);
CREATE INDEX "embeddings_3072_user_owner_idx" ON "embeddings_3072"("user_id", "owner_kind", "owner_id");

-- raw: add the pgvector columns Prisma cannot model.
ALTER TABLE "embeddings_1024" ADD COLUMN "vector" vector(1024) NOT NULL;
ALTER TABLE "embeddings_3072" ADD COLUMN "vector" vector(3072) NOT NULL;

-- raw: ANN indexes — HNSW for high-churn corpora, IVFFlat for slow-churn (audit D2).
CREATE INDEX "embeddings_1024_qa_hnsw_idx" ON "embeddings_1024"
  USING hnsw ("vector" vector_cosine_ops) WITH (m = 16, ef_construction = 64)
  WHERE "owner_kind" IN ('qa_memory','frequent_answer');
CREATE INDEX "embeddings_1024_slow_ivf_idx" ON "embeddings_1024"
  USING ivfflat ("vector" vector_cosine_ops) WITH (lists = 100)
  WHERE "owner_kind" IN ('job','experience','project','skill','resume_version');

-- raw: unified read view over both dimensions (metadata only; callers join by id+dim).
CREATE VIEW "embeddings" AS
  SELECT "id","user_id","tenant_id","owner_kind","owner_id","model","text_hash","created_at", 1024 AS "dim" FROM "embeddings_1024"
  UNION ALL
  SELECT "id","user_id","tenant_id","owner_kind","owner_id","model","text_hash","created_at", 3072 AS "dim" FROM "embeddings_3072";

-- =============================================================================
-- embedding_refresh_queue (audit D7)
-- =============================================================================
CREATE TABLE "embedding_refresh_queue" (
  "id"          BIGSERIAL NOT NULL,
  "user_id"     UUID NOT NULL,
  "tenant_id"   UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  "owner_kind"  TEXT NOT NULL,
  "owner_id"    UUID NOT NULL,
  "reason"      TEXT NOT NULL,
  "enqueued_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "processed_at" TIMESTAMPTZ,
  "attempts"    INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "embedding_refresh_queue_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "embedding_refresh_queue_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE INDEX "embedding_refresh_pending_idx" ON "embedding_refresh_queue"("enqueued_at") WHERE "processed_at" IS NULL;

-- =============================================================================
-- resume_versions
-- =============================================================================
CREATE TABLE "resume_versions" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id"       UUID NOT NULL,
  "tenant_id"     UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  "version"       INTEGER NOT NULL,
  "based_on_id"   UUID,
  "label"         TEXT,
  "parsed"        JSONB NOT NULL DEFAULT '{}'::jsonb,
  "patch_ops"     JSONB NOT NULL DEFAULT '[]'::jsonb,
  "artifact_uri"  TEXT,
  "ai_decision_id" BIGINT,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "resume_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "resume_versions_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "resume_versions_user_version_idx" ON "resume_versions"("user_id", "version");
CREATE INDEX "resume_versions_user_created_idx" ON "resume_versions"("user_id", "created_at" DESC);

-- =============================================================================
-- profile_recommendations
-- =============================================================================
CREATE TABLE "profile_recommendations" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id"          UUID NOT NULL,
  "tenant_id"        UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  "area"             TEXT NOT NULL,
  "issue"            TEXT NOT NULL,
  "expected_benefit" TEXT NOT NULL,
  "current_text"     TEXT NOT NULL,
  "proposed_text"    TEXT NOT NULL,
  "confidence"       NUMERIC(4,3) NOT NULL,
  "references"       JSONB NOT NULL DEFAULT '[]'::jsonb,
  "ai_decision_id"   BIGINT,
  "status"           TEXT NOT NULL DEFAULT 'pending',
  "decided_at"       TIMESTAMPTZ,
  "decided_by"       UUID,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "profile_recommendations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "profile_recommendations_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "profile_recommendations_status_chk" CHECK ("status" IN ('pending','approved','rejected','expired'))
);
CREATE INDEX "profile_recommendations_user_status_idx" ON "profile_recommendations"("user_id", "status");

-- =============================================================================
-- ai_eval_results
-- =============================================================================
CREATE TABLE "ai_eval_results" (
  "id"             BIGSERIAL NOT NULL,
  "prompt_key"     TEXT NOT NULL,
  "prompt_version" INTEGER NOT NULL,
  "case_id"        TEXT NOT NULL,
  "passed"         BOOLEAN NOT NULL,
  "score"          NUMERIC(5,4),
  "details"        JSONB NOT NULL DEFAULT '{}'::jsonb,
  "run_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "ai_eval_results_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ai_eval_results_case_idx" ON "ai_eval_results"("prompt_key", "prompt_version", "case_id", "run_at");
CREATE INDEX "ai_eval_results_prompt_idx" ON "ai_eval_results"("prompt_key", "prompt_version");

-- =============================================================================
-- raw: atomic cost-governor debit (audit B1).
-- Race-free single-statement debit: increments spend ONLY when it stays at or
-- below the ceiling, returning the new spend. NULL return => would breach.
-- =============================================================================
CREATE OR REPLACE FUNCTION ai_cost_try_debit(
  p_user_id UUID,
  p_tenant_id UUID,
  p_day DATE,
  p_cost NUMERIC,
  p_ceiling NUMERIC
) RETURNS NUMERIC AS $$
DECLARE
  new_spent NUMERIC;
BEGIN
  -- Ensure the row exists with the current ceiling.
  INSERT INTO ai_cost_ledger (user_id, tenant_id, day, spent_usd, ceiling_usd, calls)
    VALUES (p_user_id, p_tenant_id, p_day, 0, p_ceiling, 0)
    ON CONFLICT (user_id, day) DO UPDATE SET ceiling_usd = EXCLUDED.ceiling_usd;

  -- Atomic guarded increment.
  UPDATE ai_cost_ledger
     SET spent_usd = spent_usd + p_cost,
         calls = calls + 1,
         updated_at = now()
   WHERE user_id = p_user_id AND day = p_day
     AND spent_usd + p_cost <= ceiling_usd
  RETURNING spent_usd INTO new_spent;

  RETURN new_spent; -- NULL when the WHERE guard failed (would breach ceiling)
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- DOWN (manual rollback — Prisma migrations are forward-only):
--   DROP FUNCTION IF EXISTS ai_cost_try_debit(UUID,UUID,DATE,NUMERIC,NUMERIC);
--   DROP VIEW IF EXISTS "embeddings";
--   DROP TABLE IF EXISTS "ai_eval_results","profile_recommendations","resume_versions",
--     "embedding_refresh_queue","embeddings_3072","embeddings_1024","answer_history",
--     "frequent_answers","qa_memory","ai_cost_ledger","ai_decisions","prompt_registry" CASCADE;
-- =============================================================================
