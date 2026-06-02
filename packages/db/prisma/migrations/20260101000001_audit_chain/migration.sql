-- Per-tenant hash-chain trigger on audit_log (audit fix A8).
--
-- Behavior:
--   - BEFORE INSERT: read the tenant's current head hash from audit_chain_heads,
--     compute hash = SHA-256( prev_hash || canonical(row-without-hash) ),
--     and set NEW.prev_hash + NEW.hash. Update audit_chain_heads atomically.
--   - BEFORE UPDATE/DELETE: raise. The audit log is append-only.
--
-- The canonical serialization is a deterministic JSON encoding of the row's
-- non-hash fields. We use jsonb_build_object with a fixed key order.

CREATE OR REPLACE FUNCTION audit_log_compute_hash() RETURNS TRIGGER AS $$
DECLARE
  prev BYTEA;
  current_id BIGINT;
  payload JSONB;
  digest_input BYTEA;
  new_hash BYTEA;
BEGIN
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

  -- Build the canonical payload. Field order is fixed (alphabetical by key).
  payload := jsonb_build_object(
    'action',      NEW.action,
    'actor_id',    NEW.actor_id,
    'actor_kind',  NEW.actor_kind,
    'metadata',    NEW.metadata,
    'occurred_at', NEW.occurred_at,
    'target_id',   NEW.target_id,
    'target_kind', NEW.target_kind,
    'tenant_id',   NEW.tenant_id,
    'user_id',     NEW.user_id
  );
  digest_input := prev || convert_to(payload::text, 'UTF8');
  new_hash := digest(digest_input, 'sha256');

  NEW.prev_hash := prev;
  NEW.hash := new_hash;

  -- Update head atomically. We cannot read NEW.id yet (BEFORE INSERT trigger),
  -- so we update head_id from currval after the row is inserted via an
  -- AFTER-trigger; here we just update head_hash. (The id column's default
  -- nextval is reserved by the time the BEFORE trigger fires for the row,
  -- but reading it would require currval('audit_log_id_seq'). To avoid
  -- coupling to the sequence name, we postpone the head_id update to AFTER.)
  UPDATE audit_chain_heads
    SET head_hash = new_hash, updated_at = now()
    WHERE tenant_id = NEW.tenant_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION audit_log_finalize_head_id() RETURNS TRIGGER AS $$
BEGIN
  UPDATE audit_chain_heads
    SET head_id = NEW.id
    WHERE tenant_id = NEW.tenant_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION audit_log_block_mutations() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_compute_hash_t ON audit_log;
CREATE TRIGGER audit_log_compute_hash_t
  BEFORE INSERT ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_compute_hash();

DROP TRIGGER IF EXISTS audit_log_finalize_head_id_t ON audit_log;
CREATE TRIGGER audit_log_finalize_head_id_t
  AFTER INSERT ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_finalize_head_id();

DROP TRIGGER IF EXISTS audit_log_block_update_t ON audit_log;
CREATE TRIGGER audit_log_block_update_t
  BEFORE UPDATE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_block_mutations();

DROP TRIGGER IF EXISTS audit_log_block_delete_t ON audit_log;
CREATE TRIGGER audit_log_block_delete_t
  BEFORE DELETE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_block_mutations();

-- raw: also block TRUNCATE (separate trigger semantics in PG).
DROP TRIGGER IF EXISTS audit_log_block_truncate_t ON audit_log;
CREATE TRIGGER audit_log_block_truncate_t
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT
  EXECUTE FUNCTION audit_log_block_mutations();
