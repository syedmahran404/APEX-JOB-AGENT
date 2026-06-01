// Audit-log writer. INSERTs only; UPDATE/DELETE are blocked by trigger.
// Hash and prev_hash are computed by a BEFORE INSERT trigger (migration 1).

import type { PrismaClient } from '@prisma/client';
import type { TxClient } from '../transactions.js';

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
    const client = (tx ?? (this.prisma as unknown as TxClient)) as unknown as PrismaClient;
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
    for (const row of rows) {
      const payload = JSON.stringify({
        action: row.action,
        actor_id: row.actorId,
        actor_kind: row.actorKind,
        metadata: row.metadata,
        occurred_at: row.occurredAt.toISOString(),
        target_id: row.targetId,
        target_kind: row.targetKind,
        tenant_id: row.tenantId,
        user_id: row.userId,
      });
      const expected = createHash('sha256').update(prev).update(payload, 'utf8').digest();
      if (!Buffer.from(row.hash).equals(expected)) {
        return { ok: false, brokenAtId: row.id };
      }
      prev = Buffer.from(row.hash);
    }
    return { ok: true };
  }
}
