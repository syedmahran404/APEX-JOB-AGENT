// AuditManager — wraps AuditRepository for the engine's contract.

import type { AuditRepository } from '@apex/db';
import type { AuditManager } from './interfaces.js';

export class DefaultAuditManager implements AuditManager {
  constructor(private readonly auditRepo: AuditRepository) {}

  async record(input: {
    tenantId: string;
    userId: string;
    actorKind: 'system' | 'automation_bot' | 'user';
    action: string;
    targetKind?: string;
    targetId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.auditRepo.append({
      tenantId: input.tenantId,
      userId: input.userId,
      actorKind: input.actorKind,
      action: input.action,
      targetKind: input.targetKind ?? null,
      targetId: input.targetId ?? null,
      metadata: input.metadata ?? {},
    });
  }
}
