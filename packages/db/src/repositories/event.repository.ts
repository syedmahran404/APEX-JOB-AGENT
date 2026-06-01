// Event repositories. Append-only by convention; the underlying tables are
// not blocked from UPDATE/DELETE the way `audit_log` is, but the engine
// must never invoke those operations.

import type {
  ApplicationEvent as PrismaApplicationEvent,
  PrismaClient,
  RunEvent as PrismaRunEvent,
} from '@prisma/client';
import type { TxClient } from '../transactions.js';

export interface AppendRunEventInput {
  tenantId: string;
  runId: string;
  userId: string;
  kind: string;
  payload?: Record<string, unknown>;
}

export interface AppendApplicationEventInput {
  tenantId: string;
  applicationId: string;
  userId: string;
  kind: string;
  payload?: Record<string, unknown>;
}

export class RunEventRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async append(input: AppendRunEventInput, tx?: TxClient): Promise<void> {
    const client = (tx ?? (this.prisma as unknown as TxClient)) as unknown as PrismaClient;
    await client.runEvent.create({
      data: {
        tenantId: input.tenantId,
        runId: input.runId,
        userId: input.userId,
        kind: input.kind,
        payload: (input.payload ?? {}) as never,
      },
    });
  }

  async listForRun(runId: string, opts: { limit?: number; sinceId?: bigint } = {}): Promise<ReadonlyArray<PrismaRunEvent>> {
    return this.prisma.runEvent.findMany({
      where: { runId, ...(opts.sinceId !== undefined ? { id: { gt: opts.sinceId } } : {}) },
      orderBy: { occurredAt: 'asc' },
      take: opts.limit ?? 1_000,
    });
  }
}

export class ApplicationEventRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async append(input: AppendApplicationEventInput, tx?: TxClient): Promise<void> {
    const client = (tx ?? (this.prisma as unknown as TxClient)) as unknown as PrismaClient;
    await client.applicationEvent.create({
      data: {
        tenantId: input.tenantId,
        applicationId: input.applicationId,
        userId: input.userId,
        kind: input.kind,
        payload: (input.payload ?? {}) as never,
      },
    });
  }

  async listForApplication(
    applicationId: string,
    opts: { limit?: number; sinceId?: bigint } = {},
  ): Promise<ReadonlyArray<PrismaApplicationEvent>> {
    return this.prisma.applicationEvent.findMany({
      where: { applicationId, ...(opts.sinceId !== undefined ? { id: { gt: opts.sinceId } } : {}) },
      orderBy: { occurredAt: 'asc' },
      take: opts.limit ?? 1_000,
    });
  }
}
