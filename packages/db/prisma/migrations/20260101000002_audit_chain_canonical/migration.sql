-- Corrects the per-tenant audit hash-chain canonicalization (follow-up to
-- 20260101000001_audit_chain).
--
-- WHY: the original trigger hashed `jsonb_build_object(...)::text`. Postgres
-- `jsonb` reorders object keys (by length, then bytes) and serializes a
-- timestamptz differently from JavaScript's `Date.toISOString()`, so the hash
-- produced by the trigger could never match the hash recomputed by
-- AuditRepository.verifyChain() in TypeScript. The chain verifier would report
-- an intact chain as tampered.
--
-- FIX: hash an explicit, newline-delimited `key=value` canonical string with a
-- fixed key order, an explicit NULL sentinel ('\N'), the timestamp formatted to
-- match Date.toISOString() (UTC, millisecond precision, trailing 'Z'), and the
-- metadata rendered as Postgres jsonb canonical text (which verifyChain mirrors
-- byte-for-byte). The row's occurred_at is normalized to millisecond precision
-- so there is no sub-millisecond component for the two engines to disagree on.
--
-- This only replaces the function body via CREATE OR REPLACE; the triggers from
-- migration 20260101000001 continue to reference it unchanged.

CREATE OR REPLACE FUNCTION audit_log_compute_hash() RETURNS TRIGGER AS $$
DECLARE
  prev BYTEA;
  current_id BIGINT;
  canonical TEXT;
  iso_ts TEXT;
  digest_input BYTEA;
  new_hash BYTEA;
BEGIN
  -- Normalize to millisecond precision so the canonical timestamp is
  -- byte-identical to JavaScript's Date.toISOString() during verification.
  NEW.occurred_at := date_trunc('milliseconds', NEW.occurred_at);

  -- Lock the tenant row to serialize concurrent inserts.
  SELECT head_hash, head_id INTO prev, current_id
    FROM audit_chain_heads
    WHERE tenant_id = NEW.tenant_id
    FOR UPDATE;

  IF prev IS NULL THEN
    -- First write for this tenant. Initialize the chain head.
    prev := '\x00'::bytea;
    INSERT INTO audit_chain_heads (tenant_id, head_hash, head_id)
      VALUES (NEW.tenant_id, prev, 0)
      ON CONFLICT (tenant_id) DO NOTHING;
  END IF;

  -- Build the ISO-8601 timestamp string to be byte-identical to JavaScript's
  -- Date.toISOString() => `YYYY-MM-DDTHH:MM:SS.mmmZ` (UTC, exactly 3-digit ms).
  -- We avoid to_char's `MS` token (its zero/space padding is configuration- and
  -- value-dependent). Instead the fixed-width date/time portion comes from
  -- to_char, and the 3-digit millisecond field is derived from EXTRACT and
  -- explicitly zero-padded with lpad — making the result deterministic.
  iso_ts :=
    to_char((NEW.occurred_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS') ||
    '.' ||
    lpad((floor(EXTRACT(MILLISECONDS FROM (NEW.occurred_at AT TIME ZONE 'UTC')))::int % 1000)::text, 3, '0') ||
    'Z';

  -- Canonical serialization. Fixed key order (alphabetical), one field per
  -- line as `key=value`. Nullable columns render the literal sentinel '\N'.
  -- `metadata` uses jsonb's canonical text form (keys sorted by length then
  -- bytes, ", " / ": " separators), which verifyChain reproduces exactly.
  canonical :=
    'action=' || NEW.action || E'\n' ||
    'actor_id=' || coalesce(NEW.actor_id::text, E'\\N') || E'\n' ||
    'actor_kind=' || NEW.actor_kind || E'\n' ||
    'metadata=' || NEW.metadata::text || E'\n' ||
    'occurred_at=' || iso_ts || E'\n' ||
    'target_id=' || coalesce(NEW.target_id::text, E'\\N') || E'\n' ||
    'target_kind=' || coalesce(NEW.target_kind, E'\\N') || E'\n' ||
    'tenant_id=' || NEW.tenant_id::text || E'\n' ||
    'user_id=' || coalesce(NEW.user_id::text, E'\\N');

  digest_input := prev || convert_to(canonical, 'UTF8');
  new_hash := digest(digest_input, 'sha256');

  NEW.prev_hash := prev;
  NEW.hash := new_hash;

  -- Update head hash atomically (head_id is finalized by the AFTER trigger).
  UPDATE audit_chain_heads
    SET head_hash = new_hash, updated_at = now()
    WHERE tenant_id = NEW.tenant_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
