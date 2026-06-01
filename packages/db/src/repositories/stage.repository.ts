// Stage repository. Stages are seeded in bulk when a run transitions to
// planning, then updated as discovery/apply progresses.

import type { PrismaClient, RunStage as PrismaRunStage, StageStatus } from '@prisma/client';
import type { TxClient } from '../transactions.js';

export interface SeedStageInput {
  tenantId: string;
  runId: string;
  platformId: string;
  ordinal: number;
  target: number;
}

export class StageRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async seedMany(stages: ReadonlyArray<SeedStageInput>, tx?: TxClient): Promise<number> {
    if (stages.length === 0) return 0;
    const client = (tx ?? (this.prisma as unknown as TxClient)) as unknown as PrismaClient;
    const r = await client.runStage.createMany({
      data: stages.map((s) => ({
        tenantId: s.tenantId,
        runId: s.runId,
        platformId: s.platformId,
        ordinal: s.ordinal,
        target: s.target,
      })),
      skipDuplicates: true,
    });
    return r.count;
  }

  async listForRun(runId: string): Promise<ReadonlyArray<PrismaRunStage>> {
    return this.prisma.runStage.findMany({
      where: { runId },
      orderBy: { ordinal: 'asc' },
    });
  }

  async findById(id: string): Promise<PrismaRunStage | null> {
    return this.prisma.runStage.findUnique({ where: { id } });
  }

  async findActiveByRun(runId: string): Promise<PrismaRunStage | null> {
    return this.prisma.runStage.findFirst({
      where: { runId, status: { in: ['pending', 'discovering', 'applying'] } },
      orderBy: { ordinal: 'asc' },
    });
  }

  async setStatus(
    stageId: string,
    status: StageStatus,
    extra: { reason?: string | null; startedAt?: Date | null; finishedAt?: Date | null } = {},
    tx?: TxClient,
  ): Promise<PrismaRunStage> {
    const client = (tx ?? (this.prisma as unknown as TxClient)) as unknown as PrismaClient;
    return client.runStage.update({
      where: { id: stageId },
      data: {
        status,
        ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
        ...(extra.startedAt !== undefined ? { startedAt: extra.startedAt } : {}),
        ...(extra.finishedAt !== undefined ? { finishedAt: extra.finishedAt } : {}),
      },
    });
  }

  async incrementCounters(
    stageId: string,
    delta: { applied?: number; skipped?: number; failed?: number },
    tx?: TxClient,
  ): Promise<PrismaRunStage> {
    const client = (tx ?? (this.prisma as unknown as TxClient)) as unknown as PrismaClient;
    return client.runStage.update({
      where: { id: stageId },
      data: {
        ...(delta.applied !== undefined ? { appliedCount: { increment: delta.applied } } : {}),
        ...(delta.skipped !== undefined ? { skippedCount: { increment: delta.skipped } } : {}),
        ...(delta.failed !== undefined ? { failedCount: { increment: delta.failed } } : {}),
      },
    });
  }
}
