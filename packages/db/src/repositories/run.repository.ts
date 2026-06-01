// Run repository — owner of the run-status field. The orchestrator (or, in
// Phase 2, the worker acting as a self-orchestrator) is the SINGLE WRITER
// per audit fix B4 (fencing tokens).

import type { JobRun as PrismaJobRun, PrismaClient, RunStatus, RunMode } from '@prisma/client';
import { ConflictError, NotFoundError, PreconditionFailedError } from '@apex/shared-errors';
import type { TxClient } from '../transactions.js';

export interface CreateRunInput {
  tenantId: string;
  userId: string;
  mode: RunMode;
  targetPerPlatform: number;
  thresholdScore: number;
  autonomous: boolean;
  dryRun: boolean;
  requestedPlatforms: ReadonlyArray<string>;
  idempotencyKey: string;
  config?: Record<string, unknown>;
}

export interface FencedUpdateInput {
  runId: string;
  expectedFence: bigint;
  patch: {
    status?: RunStatus;
    control?: 'run' | 'pause' | 'stop';
    startedAt?: Date | null;
    finishedAt?: Date | null;
    ownerReplica?: string | null;
  };
}

export class RunRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateRunInput, tx?: TxClient): Promise<PrismaJobRun> {
    const client = (tx ?? (this.prisma as unknown as TxClient)) as unknown as PrismaClient;
    try {
      return await client.jobRun.create({
        data: {
          tenantId: input.tenantId,
          userId: input.userId,
          mode: input.mode,
          targetPerPlatform: input.targetPerPlatform,
          thresholdScore: input.thresholdScore,
          autonomous: input.autonomous,
          dryRun: input.dryRun,
          requestedPlatforms: [...input.requestedPlatforms],
          idempotencyKey: input.idempotencyKey,
          config: (input.config ?? {}) as never,
        },
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2002') {
        // Idempotency replay: caller must look up by (userId, idempotencyKey).
        throw new ConflictError('Run with this idempotency key already exists', {
          userId: input.userId,
          idempotencyKey: input.idempotencyKey,
        });
      }
      throw err;
    }
  }

  async findById(id: string): Promise<PrismaJobRun | null> {
    return this.prisma.jobRun.findUnique({ where: { id } });
  }

  async requireById(id: string): Promise<PrismaJobRun> {
    const r = await this.findById(id);
    if (!r) throw new NotFoundError('Run not found', { id });
    return r;
  }

  async findByIdempotencyKey(userId: string, idempotencyKey: string): Promise<PrismaJobRun | null> {
    return this.prisma.jobRun.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
    });
  }

  async listActiveForUser(userId: string): Promise<ReadonlyArray<PrismaJobRun>> {
    return this.prisma.jobRun.findMany({
      where: {
        userId,
        status: { in: ['pending', 'planning', 'running', 'paused'] },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Acquire ownership of a run for a worker replica. Increments lease_fence
   * and writes ownerReplica. Returns the new fence value or throws if the
   * row no longer exists.
   *
   * Audit fix B4: every state-mutating call from this owner must include
   * a `WHERE lease_fence = $fence` predicate (see fencedUpdate below).
   */
  async acquireOwnership(runId: string, replica: string, tx?: TxClient): Promise<bigint> {
    const client = (tx ?? (this.prisma as unknown as TxClient)) as unknown as PrismaClient;
    const result = await client.$queryRawUnsafe<Array<{ lease_fence: bigint }>>(
      `UPDATE job_runs
         SET lease_fence = lease_fence + 1,
             owner_replica = $1,
             updated_at = now()
       WHERE id = $2::uuid
       RETURNING lease_fence`,
      replica,
      runId,
    );
    if (result.length === 0 || !result[0]) {
      throw new NotFoundError('Run not found', { runId });
    }
    return result[0].lease_fence;
  }

  /**
   * Apply a state mutation guarded by the fencing token. If the fence has
   * been bumped by another replica, the UPDATE affects 0 rows and we throw.
   */
  async fencedUpdate(input: FencedUpdateInput, tx?: TxClient): Promise<PrismaJobRun> {
    const client = (tx ?? (this.prisma as unknown as TxClient)) as unknown as PrismaClient;
    const result = await client.jobRun.updateMany({
      where: { id: input.runId, leaseFence: input.expectedFence },
      data: input.patch,
    });
    if (result.count === 0) {
      throw new PreconditionFailedError('Run lease has been transferred', { runId: input.runId });
    }
    return client.jobRun.findUniqueOrThrow({ where: { id: input.runId } });
  }

  async releaseOwnership(runId: string, replica: string, tx?: TxClient): Promise<void> {
    const client = (tx ?? (this.prisma as unknown as TxClient)) as unknown as PrismaClient;
    await client.jobRun.updateMany({
      where: { id: runId, ownerReplica: replica },
      data: { ownerReplica: null },
    });
  }
}
