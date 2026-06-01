// BaseAutomationEngine — the heart of the automation engine.
//
// One engine instance owns one running run (per audit's single-writer rule).
// The worker creates an engine per dispatched run and discards it on completion.
//
// Lifecycle:
//   1. acquire(runId) — claim ownership via fencing token.
//   2. plan() — seed stages from requested_platforms.
//   3. start() — flip run.status = running.
//   4. iterate stages in ordinal order.
//      For each stage:
//        a. Resolve account/permission. Skip if missing or denied.
//        b. Check pause/stop. If paused, wait. If stopped, exit.
//        c. discover() via adapter; collect DiscoveredJob[].
//        d. filter + score + prioritize.
//        e. apply() each eligible job up to stage.target.
//        f. Mark stage done/skipped/failed.
//   5. finish(runStatus).

import type { Logger } from '@apex/shared-logger';
import type { Application, JobRun, RunStage, FreshnessTier } from '@apex/db';
import type { ApplyEvent, RunEvent } from '@apex/shared-events';
import { Domain, Events as Topics } from '@apex/shared-types';
import { newUlid } from '../utils/ulid.js';
import { sleep, checkCancellation } from '../utils/delay.js';
import { CancellationError, ReconPendingError, AccountBlockedError, SelectorDriftError, HumanRequiredError, MemoryPressureError, PlatformRateLimitError, SessionExpiredError } from '../types/errors.js';
import type {
  AccountResolver,
  ApplicationExecutionManager,
  AuditManager,
  BrowserManager,
  CaptchaDetectionManager,
  EventDispatcher,
  JobCollectionManager,
  JobFilteringManager,
  JobPriorityManager,
  JobScorer,
  JobUpserter,
  NotificationManager,
  PacingManager,
  PlatformManager,
  RecoveryManager,
  ScreenshotManager,
  SessionManager,
  StateManager,
} from '../managers/interfaces.js';
import type { AdapterContext, AdapterKnowledge, AdapterProfileSlice, PlatformAdapter, PlatformKey } from '../types/adapter.js';
import type { ApplicationPlan, DiscoveredJob, JobDetail, SubmitResult } from '../types/discovery.js';

export interface EngineDependencies {
  readonly browserManager: BrowserManager;
  readonly sessionManager: SessionManager;
  readonly platformManager: PlatformManager;
  readonly stateManager: StateManager;
  readonly recoveryManager: RecoveryManager;
  readonly captchaManager: CaptchaDetectionManager;
  readonly notificationManager: NotificationManager;
  readonly jobCollectionManager: JobCollectionManager;
  readonly jobFilteringManager: JobFilteringManager;
  readonly jobPriorityManager: JobPriorityManager;
  readonly applicationExecutionManager: ApplicationExecutionManager;
  readonly screenshotManager: ScreenshotManager;
  readonly auditManager: AuditManager;
  readonly accountResolver: AccountResolver;
  readonly jobScorer: JobScorer;
  readonly jobUpserter: JobUpserter;
  readonly eventDispatcher: EventDispatcher;
  readonly pacingManager: PacingManager;
  readonly logger: Logger;
  readonly knowledgeProvider: KnowledgeProvider;
}

export interface KnowledgeProvider {
  load(userId: string, tenantId: string): Promise<AdapterKnowledge>;
  loadProfile(userId: string, tenantId: string): Promise<AdapterProfileSlice>;
}

export interface EngineRunResult {
  runId: string;
  status: 'done' | 'failed' | 'stopped';
  applied: number;
  skipped: number;
  failed: number;
  reason?: string;
}

/**
 * Pause-poll interval used between stage iterations and inside discovery /
 * apply loops. Short enough for responsive pause; long enough to avoid
 * hammering PG.
 */
const PAUSE_POLL_INTERVAL_MS = 1_000;

export class BaseAutomationEngine {
  constructor(private readonly deps: EngineDependencies, private readonly replicaId: string) {}

  /**
   * Drive `runId` end-to-end.
   *
   * Throws CancellationError on cancellation; returns EngineRunResult on a
   * clean terminal transition (done / stopped / failed).
   */
  async runOnce(runId: string, cancellation: AbortSignal): Promise<EngineRunResult> {
    const log = this.deps.logger.child({ runId, replica: this.replicaId });

    // 1. Acquire run ownership (fencing token).
    let run: JobRun;
    let fence: bigint;
    try {
      const { run: r, fence: f } = await this.acquire(runId, log);
      run = r;
      fence = f;
    } catch (err) {
      log.error({ err }, 'failed to acquire run ownership');
      throw err;
    }
    log.info({ user: run.userId, mode: run.mode, dryRun: run.dryRun }, 'engine acquired run');

    // 2. Plan.
    const planResult = await this.plan(run, log);
    const stages = planResult.stages;

    // 3. Start.
    run = await this.deps.stateManager.startRun(runId, fence, this.replicaId);
    await this.publishRun({ kind: 'run.started', runId }, run);

    // 4. Iterate stages.
    let totalApplied = 0;
    let totalSkipped = 0;
    let totalFailed = 0;
    let stoppedEarly = false;

    for (const stage of stages) {
      checkCancellation(cancellation);
      // Pause/stop poll BEFORE doing any work for the stage.
      const continueAction = await this.waitWhilePaused(runId, cancellation);
      if (continueAction === 'stop') {
        stoppedEarly = true;
        break;
      }

      try {
        const stageResult = await this.runStage({ run, stage, cancellation, log: log.child({ stageId: stage.id }) });
        totalApplied += stageResult.applied;
        totalSkipped += stageResult.skipped;
        totalFailed += stageResult.failed;
      } catch (err) {
        if (err instanceof CancellationError) throw err;
        log.error({ err, stageId: stage.id }, 'stage threw — marking failed and continuing run');
        totalFailed += 1;
        await this.deps.stateManager.finishStage(stage.id, 'failed', (err as Error).message);
        await this.publishRun(
          { kind: 'stage.failed', runId, stageId: stage.id, reason: (err as Error).message },
          run,
        );
      }
    }

    // 5. Finish.
    const finalStatus: 'done' | 'stopped' = stoppedEarly ? 'stopped' : 'done';
    const reason = stoppedEarly ? 'user_stop' : undefined;
    const updated = await this.deps.stateManager.finishRun(runId, fence, finalStatus, reason);

    if (finalStatus === 'done') {
      await this.publishRun(
        { kind: 'run.done', runId, applied: totalApplied, skipped: totalSkipped, failed: totalFailed },
        updated,
      );
    } else {
      await this.publishRun({ kind: 'run.stopped', runId }, updated);
    }
    await this.deps.auditManager.record({
      tenantId: updated.tenantId,
      userId: updated.userId,
      actorKind: 'automation_bot',
      action: `run.${finalStatus}`,
      targetKind: 'run',
      targetId: updated.id,
      metadata: { applied: totalApplied, skipped: totalSkipped, failed: totalFailed },
    });

    return {
      runId,
      status: finalStatus,
      applied: totalApplied,
      skipped: totalSkipped,
      failed: totalFailed,
      ...(reason ? { reason } : {}),
    };
  }

  // =========================================================================
  // Phase: ACQUIRE
  // =========================================================================

  private async acquire(runId: string, log: Logger): Promise<{ run: JobRun; fence: bigint }> {
    // Engine reads run via the StateManager (which wraps RunRepository).
    const planned = await this.deps.stateManager.planRun(runId);
    // planRun atomically calls acquireOwnership inside its transaction; it
    // returns the run + fence implicitly via the run row, but we also need
    // the fence for subsequent fenced updates. The state manager exposes
    // both via `acquireRun` below; we adapt here for clarity.
    const fence = planned.run.leaseFence;
    log.debug({ fence }, 'acquired run ownership');
    return { run: planned.run, fence };
  }

  // =========================================================================
  // Phase: PLAN
  // =========================================================================

  private async plan(run: JobRun, log: Logger): Promise<{ stages: ReadonlyArray<RunStage> }> {
    const planned = await this.deps.stateManager.planRun(run.id);
    log.info({ stages: planned.stages.length }, 'planned stages');
    await this.publishRun(
      {
        kind: 'run.planned',
        runId: run.id,
        stages: planned.stages.map((s) => ({ platformKey: s.platformId, ordinal: s.ordinal })),
      },
      run,
    );
    return { stages: planned.stages };
  }

  // =========================================================================
  // Phase: STAGE
  // =========================================================================

  private async runStage(input: {
    run: JobRun;
    stage: RunStage;
    cancellation: AbortSignal;
    log: Logger;
  }): Promise<{ applied: number; skipped: number; failed: number }> {
    const { run, stage, cancellation, log } = input;

    // Resolve adapter + account/permission.
    const adapter = await this.deps.platformManager.resolveById(stage.platformId);
    const platformKey = adapter.key;
    const account = await this.deps.accountResolver.resolve(run.userId, stage.platformId);
    if (!account) {
      log.info({ platformKey }, 'no platform account; skipping stage');
      await this.skipStage(run, stage, 'no_account');
      return { applied: 0, skipped: 1, failed: 0 };
    }
    if (!account.permission.allowApply) {
      log.info({ platformKey }, 'apply permission denied; skipping stage');
      await this.skipStage(run, stage, 'permission_denied');
      return { applied: 0, skipped: 1, failed: 0 };
    }
    if (account.account.status === 'blocked' || account.account.status === 'expired') {
      log.warn({ platformKey, status: account.account.status }, 'account is blocked/expired; skipping stage');
      await this.skipStage(run, stage, 'session_blocked');
      return { applied: 0, skipped: 1, failed: 0 };
    }
    if (this.deps.recoveryManager.isTripped(platformKey)) {
      log.warn({ platformKey }, 'platform circuit breaker tripped; skipping stage');
      await this.skipStage(run, stage, 'rate_limited_platform');
      return { applied: 0, skipped: 1, failed: 0 };
    }
    if (!adapter.capabilities.verifiedAgainstLive) {
      // recon-pending adapters: surface a clean skip rather than a hard error.
      log.info({ platformKey }, 'adapter not yet verified against live platform — skipping stage');
      await this.skipStage(run, stage, 'recon_pending');
      return { applied: 0, skipped: 1, failed: 0 };
    }

    // Acquire browser context for this (user, platform).
    const acquisition = await this.deps.browserManager.acquire({
      userId: run.userId,
      platformKey,
    });
    log.debug({ contextKey: acquisition.contextKey, restored: acquisition.restored }, 'browser context acquired');

    let applied = 0;
    let skipped = 0;
    let failed = 0;

    try {
      const knowledge = await this.deps.knowledgeProvider.load(run.userId, run.tenantId);
      const page = await acquisition.context.newPage();

      // Build a scoped AdapterContext for ensure-session + discovery + apply.
      const stageContext = this.buildAdapterContext({
        run,
        stage,
        applicationId: null,
        adapter,
        page,
        cancellation,
        knowledge,
        log,
      });

      // ensureSession — bounded retry.
      await this.deps.stateManager.startStage(stage.id);
      await this.publishRun({ kind: 'stage.started', runId: run.id, stageId: stage.id, platformKey }, run);
      await this.deps.recoveryManager.withRetry(
        `${platformKey}:ensure-session`,
        () => adapter.ensureSession(stageContext),
        { maxAttempts: 2 },
      );
      // Persist storage state after a successful session check.
      await this.deps.sessionManager.persist(account.account.id, acquisition.context).catch((err: unknown) => {
        log.warn({ err }, 'failed to persist storage state — continuing');
      });
      await this.deps.platformManager
        .resolveById(stage.platformId)
        .then(() => null)
        .catch(() => null);

      // ---- Discovery ----
      await this.publishRun({ kind: 'stage.discovery.started', runId: run.id, stageId: stage.id }, run);
      const filters = this.buildSearchFilters(run);
      const discovered = await this.deps.jobCollectionManager.collect({
        adapter,
        ctx: stageContext,
        filters,
        cap: filters.maxListings,
      });

      // Persist discovered jobs.
      const upserted = await this.deps.jobUpserter.upsertMany({
        tenantId: run.tenantId,
        platformId: stage.platformId,
        discovered,
      });
      const upsertedById = new Map(upserted.map((j) => [j.externalId, j]));

      // ---- Score / filter / prioritize ----
      const profile = await this.deps.knowledgeProvider.loadProfile(run.userId, run.tenantId);
      const scores = await this.deps.jobScorer
        .scoreBatch({ userId: run.userId, tenantId: run.tenantId, profile, jobs: discovered })
        .catch((err: unknown): never => {
          throw new Error(`job scorer failed: ${(err as Error).message}`);
        });
      const scoreById = new Map(scores.map((s) => [s.externalId, s.score]));

      const enriched = discovered.map((d) => ({ ...d, aiScore: scoreById.get(d.externalId) ?? 0 }));

      const filtered = await this.deps.jobFilteringManager.filter({
        userId: run.userId,
        tenantId: run.tenantId,
        platformId: stage.platformId,
        candidates: enriched,
        thresholdScore: account.permission.thresholdScore,
        rejectStale: true,
      });
      skipped += filtered.rejected.length;

      const prioritized = this.deps.jobPriorityManager.prioritize(filtered.kept as typeof enriched);

      await this.publishRun(
        {
          kind: 'stage.discovery.complete',
          runId: run.id,
          stageId: stage.id,
          found: discovered.length,
          eligible: prioritized.length,
        },
        run,
      );

      if (prioritized.length === 0) {
        await this.deps.stateManager.finishStage(stage.id, 'done');
        await this.publishRun({ kind: 'stage.done', runId: run.id, stageId: stage.id, applied: 0 }, run);
        return { applied: 0, skipped, failed };
      }

      // ---- Apply phase ----
      await this.deps.stateManager.startApplyingStage(stage.id);
      await this.publishRun({ kind: 'stage.applying', runId: run.id, stageId: stage.id }, run);

      for (const candidate of prioritized) {
        if (applied >= stage.target) break;
        checkCancellation(cancellation);
        const cont = await this.waitWhilePaused(run.id, cancellation);
        if (cont === 'stop') break;

        const job = upsertedById.get(candidate.externalId);
        if (!job) {
          // Defensive — should never happen since we just upserted.
          continue;
        }

        const result = await this.applyOne({
          run,
          stage,
          job,
          candidate,
          adapter,
          page,
          knowledge,
          context: acquisition.context,
          permission: account.permission,
          aiScore: candidate.aiScore,
          cancellation,
          log: log.child({ jobId: job.id, externalId: job.externalId }),
        }).catch((err: unknown) => ({
          outcome: 'failed' as const,
          reason: (err as Error).message,
          recoverable: false,
        }));

        if (result.outcome === 'submitted') applied += 1;
        else if (result.outcome === 'skipped') skipped += 1;
        else failed += 1;
      }

      await this.deps.stateManager.finishStage(stage.id, 'done');
      await this.publishRun({ kind: 'stage.done', runId: run.id, stageId: stage.id, applied }, run);

      return { applied, skipped, failed };
    } finally {
      await acquisition.release().catch((err: unknown) => {
        log.warn({ err }, 'failed to release browser context');
      });
    }
  }

  // =========================================================================
  // Apply one job
  // =========================================================================

  private async applyOne(input: {
    run: JobRun;
    stage: RunStage;
    job: import('@apex/db').Job;
    candidate: DiscoveredJob & { aiScore: number };
    adapter: PlatformAdapter;
    page: import('playwright').Page;
    context: import('playwright').BrowserContext;
    knowledge: AdapterKnowledge;
    permission: import('@apex/db').PlatformPermission;
    aiScore: number;
    cancellation: AbortSignal;
    log: Logger;
  }): Promise<{ outcome: 'submitted' | 'skipped' | 'failed'; reason?: string; recoverable?: boolean }> {
    const { run, stage, job, candidate, adapter, page, knowledge, permission, aiScore, cancellation, log } = input;

    // 1. Create the application row (idempotent).
    const application = await this.deps.stateManager.createApplication({
      runId: run.id,
      stageId: stage.id,
      userId: run.userId,
      tenantId: run.tenantId,
      jobId: job.id,
      platformId: stage.platformId,
      aiScore,
      resumeVersionId: null,
      freshness: candidate.freshness as FreshnessTier | null,
      adapterVersion: adapter.version,
      wasDryRun: run.dryRun,
      initialStatus: 'queued',
    });
    await this.publishApply(
      { kind: 'queued', applicationId: application.id, jobId: job.id, platformKey: adapter.key },
      application,
    );

    // 2. Build a per-application AdapterContext.
    const ctx = this.buildAdapterContext({
      run,
      stage,
      applicationId: application.id,
      adapter,
      page,
      cancellation,
      knowledge,
      log,
    });

    // 3. parseJob → canApply → apply.
    try {
      const detail = await adapter.parseJob(ctx, job.url);
      const eligibility = await adapter.canApply(ctx, detail);

      if (eligibility.kind === 'closed' || eligibility.kind === 'already_applied') {
        await this.markApplicationSkipped(application, `eligibility:${eligibility.kind}`, 'skipped_duplicate');
        return { outcome: 'skipped', reason: eligibility.kind };
      }
      if (eligibility.kind === 'external_redirect') {
        await this.markApplicationSkipped(
          application,
          `external_ats:${eligibility.ats}`,
          'skipped_external_ats',
        );
        return { outcome: 'skipped', reason: `external_ats:${eligibility.ats}` };
      }
      if (eligibility.kind === 'unsupported') {
        await this.markApplicationSkipped(application, eligibility.reason, 'skipped_recon_pending');
        return { outcome: 'skipped', reason: eligibility.reason };
      }

      const plan: ApplicationPlan = {
        applicationId: application.id,
        resumeVersionId: null,
        coverLetterId: null,
        dryRun: run.dryRun,
        autonomous: run.autonomous,
        pacingProfile: this.coercePacingProfile(permission.pacingProfile),
        maxDurationMs: 10 * 60_000,
        idempotencyKey: application.idempotencyKey,
      };

      // Status: submitting (the adapter will emit `submitted` if it goes through).
      await this.deps.stateManager.setApplicationStatus(application.id, 'submitting');

      const result = await this.deps.applicationExecutionManager.execute({
        adapter,
        ctx,
        job: detail,
        plan,
      });

      if (result.kind === 'submitted') {
        await this.deps.stateManager.setApplicationStatus(application.id, 'submitted', {
          submittedAt: result.submittedAt,
          externalApplicationId: result.externalApplicationId ?? null,
        });
        await this.publishApply(
          {
            kind: 'submitted',
            applicationId: application.id,
            confirmation: result.confirmation,
            ...(result.externalApplicationId !== null
              ? { externalApplicationId: result.externalApplicationId }
              : {}),
          },
          application,
        );
        await this.deps.stateManager.incrementStage(stage.id, { applied: 1 });
        return { outcome: 'submitted' };
      }
      if (result.kind === 'skipped') {
        await this.markApplicationSkipped(application, result.reason, 'skipped_human_required');
        return { outcome: 'skipped', reason: result.reason };
      }
      // failed
      await this.markApplicationFailed(application, result.reason, 'failed_platform_error');
      return { outcome: 'failed', reason: result.reason, recoverable: result.recoverable };
    } catch (err) {
      if (err instanceof CancellationError) throw err;
      const { status, reason } = this.classifyError(err);
      log.warn({ err, status }, 'apply failed');
      if (status.startsWith('skipped_')) {
        await this.markApplicationSkipped(application, reason, status);
      } else {
        await this.markApplicationFailed(application, reason, status);
      }
      // Trip platform circuit breaker for some errors.
      if (err instanceof PlatformRateLimitError) {
        this.deps.recoveryManager.trip(adapter.key, err.waitMs, 'platform_rate_limit');
      } else if (err instanceof AccountBlockedError) {
        this.deps.recoveryManager.trip(adapter.key, 60 * 60_000, 'account_blocked');
      } else if (err instanceof MemoryPressureError) {
        this.deps.recoveryManager.trip(adapter.key, 10 * 60_000, 'memory_pressure');
      }
      return {
        outcome: status.startsWith('skipped_') ? 'skipped' : 'failed',
        reason,
      };
    }
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private async waitWhilePaused(runId: string, cancellation: AbortSignal): Promise<'continue' | 'stop'> {
    let last: 'run' | 'pause' | 'stop' = 'run';
    for (;;) {
      checkCancellation(cancellation);
      const control = await this.deps.stateManager.readControl(runId);
      if (control === 'run') return 'continue';
      if (control === 'stop') return 'stop';
      // paused
      if (last !== 'pause') {
        this.deps.logger.info({ runId }, 'run paused; waiting');
        last = 'pause';
      }
      await sleep(PAUSE_POLL_INTERVAL_MS, cancellation);
    }
  }

  private async skipStage(run: JobRun, stage: RunStage, reason: string): Promise<void> {
    await this.deps.stateManager.finishStage(stage.id, 'skipped', reason);
    await this.publishRun(
      { kind: 'stage.skipped', runId: run.id, stageId: stage.id, reason },
      run,
    );
  }

  private async markApplicationSkipped(
    application: Application,
    reason: string,
    status:
      | 'skipped_human_required'
      | 'skipped_low_score'
      | 'skipped_stale'
      | 'skipped_external_ats'
      | 'skipped_recon_pending'
      | 'skipped_duplicate',
  ): Promise<void> {
    await this.deps.stateManager.setApplicationStatus(application.id, status, { reason });
    await this.publishApply(
      { kind: 'skipped', applicationId: application.id, reason },
      application,
    );
  }

  private async markApplicationFailed(
    application: Application,
    reason: string,
    status: string,
  ): Promise<void> {
    const safeStatus =
      status === 'failed_selector_drift' ? 'failed_selector_drift' : 'failed_platform_error';
    await this.deps.stateManager.setApplicationStatus(application.id, safeStatus, { reason });
    await this.publishApply(
      { kind: 'step.failed', applicationId: application.id, step: 'apply', reason, recoverable: false },
      application,
    );
  }

  private classifyError(err: unknown): { status: string; reason: string } {
    if (err instanceof SelectorDriftError) {
      return { status: 'failed_selector_drift', reason: `selector_drift:${err.selector}` };
    }
    if (err instanceof HumanRequiredError) {
      return { status: 'skipped_human_required', reason: `human_required:${err.reason}` };
    }
    if (err instanceof ReconPendingError) {
      return { status: 'skipped_recon_pending', reason: 'adapter_recon_pending' };
    }
    if (err instanceof AccountBlockedError) {
      return { status: 'failed_platform_error', reason: `account_blocked:${err.platformKey}` };
    }
    if (err instanceof PlatformRateLimitError) {
      return { status: 'failed_platform_error', reason: 'platform_rate_limit' };
    }
    if (err instanceof SessionExpiredError) {
      return { status: 'failed_platform_error', reason: 'session_expired' };
    }
    if (err instanceof MemoryPressureError) {
      return { status: 'failed_platform_error', reason: 'memory_pressure' };
    }
    return { status: 'failed_platform_error', reason: (err as Error).message ?? 'unknown' };
  }

  private buildSearchFilters(run: JobRun): Domain.SearchFilters {
    const config = run.config as { query?: string; locations?: string[]; remoteKinds?: Domain.RemoteKind[]; postedWithinMin?: number; maxListings?: number };
    return Domain.SearchFilters.parse({
      query: config.query ?? 'software engineer',
      locations: config.locations ?? [],
      remoteKinds: config.remoteKinds ?? [],
      postedWithinMin: config.postedWithinMin ?? Domain.FRESHNESS_WINDOWS_MIN.t5d,
      maxListings: config.maxListings ?? 200,
    });
  }

  private coercePacingProfile(value: string): 'STRICT_DEFAULT' | 'BALANCED' | 'FAST' {
    if (value === 'BALANCED') return 'BALANCED';
    if (value === 'FAST') return 'FAST';
    return 'STRICT_DEFAULT';
  }

  private buildAdapterContext(input: {
    run: JobRun;
    stage: RunStage;
    applicationId: string | null;
    adapter: PlatformAdapter;
    page: import('playwright').Page;
    cancellation: AbortSignal;
    knowledge: AdapterKnowledge;
    log: Logger;
  }): AdapterContext {
    const { run, applicationId, adapter, page, cancellation, knowledge, log } = input;
    return {
      page,
      browserContext: page.context(),
      logger: log.child({ adapter: adapter.key, adapterVersion: adapter.version }),
      tenantId: run.tenantId,
      userId: run.userId,
      runId: run.id,
      applicationId,
      adapterVersion: adapter.version,
      topics: Topics,
      cancellation,
      random: Math.random,
      now: () => new Date(),
      emit: (event: ApplyEvent) => {
        // Fire-and-forget; transport errors are swallowed (caller perspective).
        void this.deps.eventDispatcher
          .publishApplyEvent(event, {
            applicationId: applicationId ?? newUlid(),
            userId: run.userId,
            tenantId: run.tenantId,
          })
          .catch((err: unknown) => log.warn({ err }, 'event publish failed'));
      },
      pace: (action) =>
        this.deps.pacingManager.acquire({
          platformKey: adapter.key,
          userId: run.userId,
          action,
        }),
      knowledge,
    };
  }

  private async publishRun(event: RunEvent, run: { tenantId: string; userId: string; id: string }): Promise<void> {
    await this.deps.eventDispatcher
      .publishRunEvent(event, { runId: run.id, userId: run.userId, tenantId: run.tenantId })
      .catch((err: unknown) => this.deps.logger.warn({ err, kind: event.kind }, 'run event publish failed'));
  }

  private async publishApply(event: ApplyEvent, app: { tenantId: string; userId: string; id: string }): Promise<void> {
    await this.deps.eventDispatcher
      .publishApplyEvent(event, { applicationId: app.id, userId: app.userId, tenantId: app.tenantId })
      .catch((err: unknown) =>
        this.deps.logger.warn({ err, kind: event.kind }, 'apply event publish failed'),
      );
  }
}
