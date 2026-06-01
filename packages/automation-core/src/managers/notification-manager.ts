// NotificationManager — for Phase 2 we route notifications through the
// audit_log so they are durable and observable. The dedicated
// `notifications` table + delivery worker ship in Phase 6 per the audit
// roadmap; the interface stays the same.

import type { Logger } from '@apex/shared-logger';
import type { AuditRepository } from '@apex/db';
import type { NotificationManager } from './interfaces.js';

export interface DefaultNotificationManagerOptions {
  logger: Logger;
  auditRepo: AuditRepository;
}

export class DefaultNotificationManager implements NotificationManager {
  private readonly logger: Logger;
  constructor(private readonly opts: DefaultNotificationManagerOptions) {
    this.logger = opts.logger.child({ component: 'notification-manager' });
  }

  async notify(input: {
    userId: string;
    tenantId: string;
    kind: string;
    title: string;
    body: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    this.logger.info({ kind: input.kind, userId: input.userId, title: input.title }, 'notification');
    await this.opts.auditRepo.append({
      tenantId: input.tenantId,
      actorKind: 'system',
      userId: input.userId,
      action: `notification.${input.kind}`,
      metadata: { title: input.title, body: input.body, ...(input.metadata ?? {}) },
    });
  }
}
