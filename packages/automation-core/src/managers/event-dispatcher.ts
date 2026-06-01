// EventDispatcher — fans events out to (a) durable outbox in PG and (b)
// Redis Pub/Sub for live UI updates. Per audit fix B7, ordering is
// guaranteed per-aggregate by funneling all writes through a single
// outbox-relay (Phase 4 hardening); for Phase 2 we publish in order from
// the engine and the relay is the simple drainer.

import type { Logger } from '@apex/shared-logger';
import { Events as Topics } from '@apex/shared-types';
import type { ApplyEvent, RunEvent } from '@apex/shared-events';
import { appendOutbox, runInTransaction, type ApplicationEventRepository, type AppendOutboxInput, type PrismaClient, type RunEventRepository } from '@apex/db';
import type { Redis } from 'ioredis';
import type { EventDispatcher } from './interfaces.js';

export interface DefaultEventDispatcherOptions {
  logger: Logger;
  prisma: PrismaClient;
  redis: Redis;
  runEventRepo: RunEventRepository;
  applicationEventRepo: ApplicationEventRepository;
}

export class DefaultEventDispatcher implements EventDispatcher {
  private readonly logger: Logger;
  constructor(private readonly opts: DefaultEventDispatcherOptions) {
    this.logger = opts.logger.child({ component: 'event-dispatcher' });
  }

  async publishRunEvent(
    event: RunEvent,
    ctx: { runId: string; userId: string; tenantId: string },
  ): Promise<void> {
    await runInTransaction(this.opts.prisma, async (tx) => {
      await this.opts.runEventRepo.append(
        {
          tenantId: ctx.tenantId,
          runId: ctx.runId,
          userId: ctx.userId,
          kind: event.kind,
          payload: event,
        },
        tx,
      );
      const outbox: AppendOutboxInput = {
        tenantId: ctx.tenantId,
        aggregate: 'run',
        aggregateId: ctx.runId,
        topic: Topics.runTopic(ctx.runId),
        payload: event,
      };
      await appendOutbox(tx, outbox);
    });
    // Best-effort publish to Redis for live consumers.
    try {
      await this.opts.redis.publish(Topics.runTopic(ctx.runId), JSON.stringify(event));
      await this.opts.redis.publish(Topics.userTopic(ctx.userId), JSON.stringify(event));
    } catch (err) {
      this.logger.warn({ err, kind: event.kind }, 'redis publish failed (run)');
    }
  }

  async publishApplyEvent(
    event: ApplyEvent,
    ctx: { applicationId: string; userId: string; tenantId: string },
  ): Promise<void> {
    await runInTransaction(this.opts.prisma, async (tx) => {
      await this.opts.applicationEventRepo.append(
        {
          tenantId: ctx.tenantId,
          applicationId: ctx.applicationId,
          userId: ctx.userId,
          kind: event.kind,
          payload: event,
        },
        tx,
      );
      const outbox: AppendOutboxInput = {
        tenantId: ctx.tenantId,
        aggregate: 'application',
        aggregateId: ctx.applicationId,
        topic: Topics.userTopic(ctx.userId),
        payload: event,
      };
      await appendOutbox(tx, outbox);
    });
    try {
      await this.opts.redis.publish(Topics.userTopic(ctx.userId), JSON.stringify(event));
    } catch (err) {
      this.logger.warn({ err, kind: event.kind }, 'redis publish failed (apply)');
    }
  }
}
