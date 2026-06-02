// Audit-log writer. INSERTs only; UPDATE/DELETE are blocked by trigger.
// Hash and prev_hash are computed by a BEFORE INSERT trigger (migration 1).

import type { PrismaClient } from '@prisma/client';
import type { TxClient } from '../transactions.js';

/**
 * Render a value exactly as PostgreSQL's `jsonb::text` would: object keys sorted
 * by UTF-8 byte length then byte order, `", "` between entries and `": "` after
 * keys, standard JSON scalar formatting. This mirrors what the audit trigger
 * concatenates for `metadata`, so verifyChain reproduces the trigger's hash.
 *
 * Limitation: jsonb numeric normalization edge cases (e.g. exponent forms) are
 * not reproduced; audit metadata in practice contains strings, integers,
 * booleans, nulls, and nested objects/arrays of those.
 */
function jsonbText(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(jsonbText).join(', ') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort(compareJsonbKeys);
  return '{' + keys.map((k) => JSON.stringify(k) + ': ' + jsonbText(obj[k])).join(', ') + '}';
}

function compareJsonbKeys(a: string, b: string): number {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return ab.length - bb.length;
  return Buffer.compare(ab, bb);
}

export interface AuditEntry {
  tenantId: string;
  actorKind: 'user' | 'system' | 'ai' | 'automation_bot' | 'support';
  actorId?: string | null;
  userId?: string | null;
  action: string;
  targetKind?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ipInet?: string | null;
  userAgent?: string | null;
}

export class AuditRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async append(entry: AuditEntry, tx?: TxClient): Promise<void> {
    const client = (tx ?? (this.prisma)) as PrismaClient;
    await client.auditLog.create({
      data: {
        tenantId: entry.tenantId,
        actorKind: entry.actorKind,
        actorId: entry.actorId ?? null,
        userId: entry.userId ?? null,
        action: entry.action,
        targetKind: entry.targetKind ?? null,
        targetId: entry.targetId ?? null,
        metadata: (entry.metadata ?? {}) as never,
        ipInet: entry.ipInet ?? null,
        userAgent: entry.userAgent ?? null,
        // hash + prev_hash are computed by the trigger (audit_log_compute_hash).
        // We must still provide a placeholder for `hash` because Prisma's
        // generated insert lists every NOT NULL column. PG ignores it because
        // the trigger overrides NEW.hash before the row is written.
        hash: Buffer.alloc(0),
      },
    });
  }

  /**
   * Verify the hash chain for a tenant. Walks all rows in occurredAt order;
   * recomputes each hash; returns first inconsistency or null on success.
   * Used by the daily verifier (apps/scheduler).
   */
  async verifyChain(tenantId: string): Promise<{ ok: true } | { ok: false; brokenAtId: bigint }> {
    const rows = await this.prisma.auditLog.findMany({
      where: { tenantId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        occurredAt: true,
        actorKind: true,
        actorId: true,
        userId: true,
        action: true,
        targetKind: true,
        targetId: true,
        metadata: true,
        prevHash: true,
        hash: true,
        tenantId: true,
      },
    });
    let prev: Buffer = Buffer.from([0]);
    const { createHash } = await import('node:crypto');
    // Sentinel for NULL columns; must match the trigger's E'\\N' (backslash-N).
    const NULL = '\\N';
    for (const row of rows) {
      // Canonical form must be byte-identical to the audit trigger
      // (migration 20260101000002): fixed key order, `key=value` per line,
      // '\N' for nulls, jsonb-canonical metadata, ISO-8601 ms-precision UTC time.
      const canonical = [
        `action=${row.action}`,
        `actor_id=${row.actorId ?? NULL}`,
        `actor_kind=${row.actorKind}`,
        `metadata=${jsonbText(row.metadata)}`,
        `occurred_at=${row.occurredAt.toISOString()}`,
        `target_id=${row.targetId ?? NULL}`,
        `target_kind=${row.targetKind ?? NULL}`,
        `tenant_id=${row.tenantId}`,
        `user_id=${row.userId ?? NULL}`,
      ].join('\n');
      const expected = createHash('sha256').update(prev).update(canonical, 'utf8').digest();
      if (!Buffer.from(row.hash).equals(expected)) {
        return { ok: false, brokenAtId: row.id };
      }
      prev = Buffer.from(row.hash);
    }
    return { ok: true };
  }
}
