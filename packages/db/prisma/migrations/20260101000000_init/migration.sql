-- APEX JOB AGENT — Initial migration (Phase 1, M0 subset).
--
-- This migration:
--  1. Enables required extensions.
--  2. Creates the M0-subset of tables (users, sessions, mfa, roles, permissions,
--     platforms, audit_log, idempotency_keys, outbox_events).
--  3. Creates a partial unique index on user_sessions for token uniqueness.
--  4. Creates a singleton tenant placeholder used until Phase 8 multi-tenant.
--  5. Defers the audit-chain trigger to migration 20260101000001 so that this
--     init migration is purely DDL and not behavior-bearing.

-- raw: extensions ------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- raw: enums -----------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "user_status" AS ENUM ('active','suspended','deleted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "email_status_enum" AS ENUM ('unverified','verified','bouncing','complained','suppressed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- users ----------------------------------------------------------------------
CREATE TABLE "users" (
  "id"                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"           UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  "email"               CITEXT NOT NULL UNIQUE,
  "display_name"        TEXT NOT NULL,
  "password_hash"       TEXT NOT NULL,
  "status"              "user_status" NOT NULL DEFAULT 'active',
  "data_key_id"         TEXT NOT NULL,
  "data_key_wrapped"    BYTEA NOT NULL,
  "email_verified_at"   TIMESTAMPTZ NULL,
  "last_login_at"       TIMESTAMPTZ NULL,
  "failed_login_count"  INTEGER NOT NULL DEFAULT 0,
  "locked_until"        TIMESTAMPTZ NULL,
  "email_status"        "email_status_enum" NOT NULL DEFAULT 'unverified',
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deleted_at"          TIMESTAMPTZ NULL
);
CREATE INDEX "users_tenant_id_idx" ON "users"("tenant_id");
CREATE INDEX "users_active_idx" ON "users"("id") WHERE "deleted_at" IS NULL;

-- user_sessions --------------------------------------------------------------
CREATE TABLE "user_sessions" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"     UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash"  BYTEA NOT NULL,
  "user_agent"  TEXT,
  "ip_inet"     INET,
  "expires_at"  TIMESTAMPTZ NOT NULL,
  "revoked_at"  TIMESTAMPTZ NULL,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "user_sessions_user_id_idx" ON "user_sessions"("user_id");
CREATE UNIQUE INDEX "user_sessions_token_idx" ON "user_sessions"("token_hash");

-- webauthn_credentials -------------------------------------------------------
CREATE TABLE "webauthn_credentials" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"        UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "credential_id"  BYTEA NOT NULL UNIQUE,
  "public_key"     BYTEA NOT NULL,
  "sign_count"     BIGINT NOT NULL DEFAULT 0,
  "transports"     TEXT[] NOT NULL DEFAULT '{}',
  "device_label"   TEXT,
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "last_used_at"   TIMESTAMPTZ NULL
);
CREATE INDEX "webauthn_credentials_user_id_idx" ON "webauthn_credentials"("user_id");

-- totp_secrets ---------------------------------------------------------------
CREATE TABLE "totp_secrets" (
  "user_id"         UUID PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "secret_wrapped"  BYTEA NOT NULL,
  "enabled_at"      TIMESTAMPTZ NULL,
  "last_used_at"    TIMESTAMPTZ NULL,
  "dek_version"     SMALLINT NOT NULL DEFAULT 1
);

-- mfa_recovery_codes ---------------------------------------------------------
CREATE TABLE "mfa_recovery_codes" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"    UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "code_hash"  BYTEA NOT NULL,
  "used_at"    TIMESTAMPTZ NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "mfa_recovery_codes_user_id_idx" ON "mfa_recovery_codes"("user_id");

-- roles + user_roles ---------------------------------------------------------
CREATE TABLE "roles" (
  "id"     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "key"    TEXT NOT NULL UNIQUE,
  "label"  TEXT NOT NULL
);

CREATE TABLE "user_roles" (
  "user_id"  UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role_id"  UUID NOT NULL REFERENCES "roles"("id") ON DELETE RESTRICT,
  PRIMARY KEY ("user_id", "role_id")
);

-- permissions + user_permissions --------------------------------------------
CREATE TABLE "permissions" (
  "id"     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "key"    TEXT NOT NULL UNIQUE,
  "label"  TEXT NOT NULL
);

CREATE TABLE "user_permissions" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"        UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "permission_id"  UUID NOT NULL REFERENCES "permissions"("id") ON DELETE RESTRICT,
  "granted_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "granted_by"     UUID NULL REFERENCES "users"("id"),
  "scope"          JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX "user_permissions_user_permission_idx" ON "user_permissions"("user_id", "permission_id");

-- platforms ------------------------------------------------------------------
CREATE TABLE "platforms" (
  "id"        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "key"       TEXT NOT NULL UNIQUE,
  "label"     TEXT NOT NULL,
  "base_url"  TEXT NOT NULL,
  "enabled"   BOOLEAN NOT NULL DEFAULT TRUE,
  "ordinal"   SMALLINT NOT NULL
);

-- audit_log ------------------------------------------------------------------
CREATE TABLE "audit_log" (
  "id"           BIGSERIAL PRIMARY KEY,
  "occurred_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "actor_kind"   TEXT NOT NULL,
  "actor_id"     UUID NULL,
  "user_id"      UUID NULL,
  "action"       TEXT NOT NULL,
  "target_kind"  TEXT NULL,
  "target_id"    UUID NULL,
  "metadata"     JSONB NOT NULL DEFAULT '{}'::jsonb,
  "prev_hash"    BYTEA NULL,
  "hash"         BYTEA NOT NULL,
  "ip_inet"      INET NULL,
  "user_agent"   TEXT NULL,
  "tenant_id"    UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'
);
CREATE INDEX "audit_log_user_idx"   ON "audit_log"("user_id", "occurred_at" DESC);
CREATE INDEX "audit_log_action_idx" ON "audit_log"("action", "occurred_at" DESC);
CREATE INDEX "audit_log_tenant_idx" ON "audit_log"("tenant_id", "occurred_at" DESC);

CREATE TABLE "audit_chain_heads" (
  "tenant_id"   UUID PRIMARY KEY,
  "head_hash"   BYTEA NOT NULL,
  "head_id"     BIGINT NOT NULL,
  "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- idempotency_keys -----------------------------------------------------------
CREATE TABLE "idempotency_keys" (
  "user_id"            UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "key"                TEXT NOT NULL,
  "method"             TEXT NOT NULL,
  "path"               TEXT NOT NULL,
  "request_hash"       BYTEA NOT NULL,
  "response_status"    INTEGER NOT NULL,
  "response_envelope"  JSONB NOT NULL,
  "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  "expires_at"         TIMESTAMPTZ NOT NULL,
  PRIMARY KEY ("user_id", "key")
);
CREATE INDEX "idempotency_keys_expires_idx" ON "idempotency_keys"("expires_at");

-- outbox_events --------------------------------------------------------------
CREATE TABLE "outbox_events" (
  "id"            BIGSERIAL PRIMARY KEY,
  "tenant_id"     UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  "occurred_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "aggregate"     TEXT NOT NULL,
  "aggregate_id"  UUID NOT NULL,
  "topic"         TEXT NOT NULL,
  "payload"       JSONB NOT NULL,
  "delivered_at"  TIMESTAMPTZ NULL,
  "attempts"      INTEGER NOT NULL DEFAULT 0,
  "last_error"    TEXT NULL
);
CREATE INDEX "outbox_events_undelivered_idx"
  ON "outbox_events"("id") WHERE "delivered_at" IS NULL;
CREATE INDEX "outbox_events_aggregate_idx"
  ON "outbox_events"("aggregate", "aggregate_id", "id");

-- raw: singleton tenant placeholder used until Phase 8 multi-tenant lands.
-- The default UUID matches the column defaults above.
INSERT INTO "audit_chain_heads" ("tenant_id", "head_hash", "head_id")
VALUES ('00000000-0000-0000-0000-000000000000', '\x00'::bytea, 0)
ON CONFLICT ("tenant_id") DO NOTHING;
