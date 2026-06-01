// StateManager — single writer to run/stage/application status fields.
// Wraps repositories so the engine touches no @apex/db internals.

import type {
  ApplicationStatus,
  Application,
  ApplicationRepository,
  AuditRepository,
  FreshnessTier,
  JobRun,
  PrismaClient,
  RunEventRepository,
  RunRepository,
  RunStage,
  StageRepository,
  StageStatus,
} from '@apex/db';
import { runInTransaction } from '@apex/db';
import { NotFoundError } from '@apex/shared-errors';
import type { Logger } from '@apex/shared-logger';
import type { StateManager } from './interfaces.js';
import { Domain } from '@apex/shared-types';

export interface DefaultStateManagerOptions {
  logger: Logger;
  prisma: PrismaClient;
  runRepo: RunRepository;
  stageRepo: StageRepository;
  applicationRepo: ApplicationRepository;
  auditRepo: AuditRepository;
  runEventRepo: RunEventRepository;
  replicaId: string;
}

export class DefaultStateManager implements StateManager {
  private readonly logger: Logger;
  private readonly prisma: PrismaClient;
  private readonly runRepo: RunRepository;
  private readonly stageRepo: StageRepository;
  private readonly applicationRepo: ApplicationRepository;
  private readonly auditRepo: AuditRepository;
  private readonly runEventRepo: RunEventRepository;
  private readonly replicaId: string;

  constructor(opts: DefaultStateManagerOptions) {
    this.logger = opts.logger.child({ component: 'state-manager' });
    this.prisma = opts.prisma;
    this.runRepo = opts.runRepo;
    this.stageRepo = opts.stageRepo;
    this.applicationRepo = opts.applicationRepo;
    this.auditRepo = opts.auditRepo;
    this.runEventRepo = opts.runEventRepo;
    this.replicaId = opts.replicaId;
  }

  async planRun(runId: string): Promise<{ run: JobRun; stages: ReadonlyArray<RunStage> }> {
    return runInTransaction(this.prisma, async (tx) => {
      const run = await this.runRepo.requireById(runId);
      // Acquire ownership (bumps fence). Idempotent: re-running plan is OK.
      await this.runRepo.acquireOwnership(runId, this.replicaId, tx);

      // Seed stages in canonical order (the order in `requested_platforms[]`).
      // skipDuplicates handles re-run.
      const seeds = run.requestedPlatforms.map((platformId, ordinal) => ({
        tenantId: run.tenantId,
        runId,
        platformId,
        ordinal,
        target: run.targetPerPlatform,
      }));
      await this.stageRepo.seedMany(seeds, tx);

      const stages = await this.stageRepo.listForRun(runId);
      const updatedRun = await this.runRepo.requireById(runId);
      // Transition pending → planning if appropriate.
      if (updatedRun.status === 'pending') {
        await this.runRepo.fencedUpdate(
          { runId, expectedFence: updatedRun.leaseFence, patch: { status: 'planning' } },
          tx,
        );
      }
      const finalRun = await this.runRepo.requireById(runId);
      return { run: finalRun, stages };
    });
  }

  async startRun(runId: string, fence: bigint, replica: string): Promise<JobRun> {
    return runInTransaction(this.prisma, async (tx) => {
      const updated = await this.runRepo.fencedUpdate(
        {
          runId,
          expectedFence: fence,
          patch: { status: 'running', startedAt: new Date(), ownerReplica: replica },
        },
        tx,
      );
      await this.runEventRepo.append(
        { tenantId: updated.tenantId, runId, userId: updated.userId, kind: 'run.started' },
        tx,
      );
      return updated;
    });
  }

  async finishRun(
    runId: string,
    fence: bigint,
    status: 'done' | 'failed' | 'stopped',
    reason?: string,
  ): Promise<JobRun> {
    return runInTransaction(this.prisma, async (tx) => {
      const updated = await this.runRepo.fencedUpdate(
        {
          runId,
          expectedFence: fence,
          patch: { status, finishedAt: new Date(), ownerReplica: null },
        },
        tx,
      );
      await this.runEventRepo.append(
        {
          tenantId: updated.tenantId,
          runId,
          userId: updated.userId,
          kind: `run.${status}`,
          payload: reason ? { reason } : {},
        },
        tx,
      );
      return updated;
    });
  }

  async readControl(runId: string): Promise<'run' | 'pause' | 'stop'> {
    const r = await this.runRepo.requireById(runId);
    if (r.control === 'pause' || r.control === 'stop') return r.control;
    return 'run';
  }

  async startStage(stageId: string): Promise<RunStage> {
    return this.stageRepo.setStatus(stageId, 'discovering', { startedAt: new Date() });
  }

  async startApplyingStage(stageId: string): Promise<RunStage> {
    return this.stageRepo.setStatus(stageId, 'applying');
  }

  async finishStage(
    stageId: string,
    status: Extract<StageStatus, 'done' | 'skipped' | 'failed'>,
    reason?: string,
  ): Promise<RunStage> {
    return this.stageRepo.setStatus(stageId, status, {
      finishedAt: new Date(),
      reason: reason ?? null,
    });
  }

  async incrementStage(
    stageId: string,
    delta: { applied?: number; skipped?: number; failed?: number },
  ): Promise<void> {
    await this.stageRepo.incrementCounters(stageId, delta);
  }

  async createApplication(input: {
    runId: string;
    stageId: string;
    userId: string;
    tenantId: string;
    jobId: string;
    platformId: string;
    aiScore: number | null;
    resumeVersionId: string | null;
    freshness: FreshnessTier | null;
    adapterVersion: string;
    wasDryRun: boolean;
    initialStatus: ApplicationStatus;
  }): Promise<Application> {
    const idempotencyKey = `apply:run:${input.runId}:stage:${input.stageId}:job:${input.jobId}`;
    const application = await this.applicationRepo.createOrRecover({
      tenantId: input.tenantId,
      userId: input.userId,
      runId: input.runId,
      stageId: input.stageId,
      jobId: input.jobId,
      platformId: input.platformId,
      status: input.initialStatus,
      aiScore: input.aiScore,
      resumeVersionId: input.resumeVersionId,
      freshnessAtApply: input.freshness,
      idempotencyKey,
      adapterVersion: input.adapterVersion,
      wasDryRun: input.wasDryRun,
    });
    return application;
  }

  async setApplicationStatus(
    applicationId: string,
    status: ApplicationStatus,
    extra?: {
      reason?: string | null;
      externalApplicationId?: string | null;
      submittedAt?: Date | null;
      outcomeAt?: Date | null;
    },
  ): Promise<Application> {
    const updated = await this.applicationRepo.setStatus({
      applicationId,
      status,
      ...extra,
    });
    if (!updated) throw new NotFoundError('Application not found', { applicationId });
    return updated;
  }

  // Helper unused by interface but useful for diagnostics.
  Domain = Domain;
}
