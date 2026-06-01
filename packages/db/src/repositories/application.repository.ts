// Application repository. Honors:
//   - audit fix A1: partial unique index on (user_id, job_id) WHERE status NOT
//     IN (terminal-retryable). Allows a retry after permanent-failure terminal
//     states; blocks duplicate live applications.
//   - audit fix B5: idempotency_key carries either run-based or manual shape;
//     UNIQUE constraint dedupes retries.

import type {
  Application as PrismaApplication,
  ApplicationStatus,
  FreshnessTier,
  PrismaClient,
} from '@prisma/client';
import { ConflictError, NotFoundError } from '@apex/shared-errors';
import type { TxClient } from '../transactions.js';

export interface CreateApplicationInput {
  tenantId: string;
  userId: string;
  runId?: string | null;
  stageId?: string | null;
  jobId: string;
  platformId: string;
  status: ApplicationStatus;
  aiScore?: number | null;
  resumeVersionId?: string | null;
  freshnessAtApply?: FreshnessTier | null;
  idempotencyKey: string;
  adapterVersion: string;
  wasDryRun: boolean;
  reason?: string | null;
}

export interface UpdateStatusInput {
  applicationId: string;
  status: ApplicationStatus;
  reason?: string | null;
  externalApplicationId?: string | null;
  submittedAt?: Date | null;
  outcomeAt?: Date | null;
}

/** Build a deterministic idempotency key for a run-driven application. */
export function buildRunIdempotencyKey(runId: string, stageId: string, jobId: string): string {
  return `apply:run:${runId}:stage:${stageId}:job:${jobId}`;
}

/** Build a deterministic idempotency key for a manual one-off application. */
export function buildManualIdempotencyKey(userId: string, jobId: string): string {
  return `apply:manual:${userId}:${jobId}`;
}

export class ApplicationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Create-or-recover: attempts to insert. On unique-violation against
   * idempotency_key it returns the existing row (idempotent retry).
   * On unique-violation against the partial active-application index it
   * also returns the existing live application — caller should treat this
   * as "already applied" rather than an error.
   */
  async createOrRecover(input: CreateApplicationInput, tx?: TxClient): Promise<PrismaApplication> {
    const client = (tx ?? (this.prisma as unknown as TxClient)) as unknown as PrismaClient;
    try {
      return await client.application.create({
        data: {
          tenantId: input.tenantId,
          userId: input.userId,
          runId: input.runId ?? null,
          stageId: input.stageId ?? null,
          jobId: input.jobId,
          platformId: input.platformId,
          status: input.status,
          aiScore: input.aiScore ?? null,
          resumeVersionId: input.resumeVersionId ?? null,
          freshnessAtApply: input.freshnessAtApply ?? null,
          idempotencyKey: input.idempotencyKey,
          adapterVersion: input.adapterVersion,
          wasDryRun: input.wasDryRun,
          reason: input.reason ?? null,
        },
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'P2002') throw err;
      // 1. Idempotency key replay.
      const byKey = await client.application.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (byKey) return byKey;
      // 2. Partial unique on (user_id, job_id) for active statuses.
      const live = await client.application.findFirst({
        where: {
          userId: input.userId,
          jobId: input.jobId,
          status: {
            notIn: [
              'failed_selector_drift',
              'failed_platform_error',
              'skipped_human_required',
              'skipped_low_score',
              'skipped_stale',
              'skipped_external_ats',
              'skipped_recon_pending',
              'skipped_duplicate',
              'duplicate',
            ],
          },
        },
      });
      if (live) return live;
      throw new ConflictError('Application uniqueness conflict', { idempotencyKey: input.idempotencyKey });
    }
  }

  async findById(id: string): Promise<PrismaApplication | null> {
    return this.prisma.application.findUnique({ where: { id } });
  }

  async requireById(id: string): Promise<PrismaApplication> {
    const a = await this.findById(id);
    if (!a) throw new NotFoundError('Application not found', { id });
    return a;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<PrismaApplication | null> {
    return this.prisma.application.findUnique({ where: { idempotencyKey } });
  }

  /**
   * Returns the live application (if any) blocking a new attempt at
   * (userId, jobId). Uses the same predicate as the partial unique index.
   */
  async findActiveForUserJob(userId: string, jobId: string): Promise<PrismaApplication | null> {
    return this.prisma.application.findFirst({
      where: {
        userId,
        jobId,
        status: {
          notIn: [
            'failed_selector_drift',
            'failed_platform_error',
            'skipped_human_required',
            'skipped_low_score',
            'skipped_stale',
            'skipped_external_ats',
            'skipped_recon_pending',
            'skipped_duplicate',
            'duplicate',
          ],
        },
      },
    });
  }

  async setStatus(input: UpdateStatusInput, tx?: TxClient): Promise<PrismaApplication> {
    const client = (tx ?? (this.prisma as unknown as TxClient)) as unknown as PrismaClient;
    return client.application.update({
      where: { id: input.applicationId },
      data: {
        status: input.status,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.externalApplicationId !== undefined
          ? { externalApplicationId: input.externalApplicationId }
          : {}),
        ...(input.submittedAt !== undefined ? { submittedAt: input.submittedAt } : {}),
        ...(input.outcomeAt !== undefined ? { outcomeAt: input.outcomeAt } : {}),
      },
    });
  }

  async listForUser(
    userId: string,
    opts: { limit?: number; status?: ApplicationStatus[] } = {},
  ): Promise<ReadonlyArray<PrismaApplication>> {
    return this.prisma.application.findMany({
      where: {
        userId,
        ...(opts.status && opts.status.length > 0 ? { status: { in: opts.status } } : {}),
      },
      orderBy: [{ submittedAt: 'desc' }, { createdAt: 'desc' }],
      take: opts.limit ?? 100,
    });
  }

  /**
   * Reaper for `submitting` rows older than thresholdMin and inactive for at
   * least quietMin (audit fix B8). Returns the affected ids; the caller
   * decides whether to verify with the worker or mark `failed_platform_error`.
   */
  async findStuckSubmitting(
    thresholdMin: number,
    quietMin: number,
    tx?: TxClient,
  ): Promise<ReadonlyArray<{ id: string; userId: string; updatedAt: Date }>> {
    const client = (tx ?? (this.prisma as unknown as TxClient)) as unknown as PrismaClient;
    const cutoffEnter = new Date(Date.now() - thresholdMin * 60_000);
    const cutoffQuiet = new Date(Date.now() - quietMin * 60_000);
    return client.application.findMany({
      where: {
        status: 'submitting',
        createdAt: { lt: cutoffEnter },
        updatedAt: { lt: cutoffQuiet },
      },
      select: { id: true, userId: true, updatedAt: true },
    });
  }
}
