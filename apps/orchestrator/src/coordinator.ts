// RunCoordinator — the single-writer orchestration core. It is the only place
// that mutates run/stage status. Every command is:
//   1. idempotency-guarded (replays are no-ops),
//   2. ownership-checked (only the owner replica acts),
//   3. applied via the pure run state machine (@apex/shared-events reduce),
//   4. persisted + dispatched + event-published atomically.
//
// All I/O is behind ports (RunStore / TaskDispatcher / EventPublisher /
// IdempotencyGuard / OwnershipLease), so the coordinator is fully unit-testable
// without PG or Redis.
//
// Reference: docs/architecture/04-backend-design.md §4 (orchestrator),
//            01-system-architecture.md (single-writer, sequential-per-platform).

import { reduce, type RunEventInput, type RunState } from '@apex/shared-events';
import {
  planRun,
  nextDispatch,
  updateStageStatus,
  runOutcome,
  type RunMode,
  type RunPlan,
  type PlatformKey,
  type StageStatus,
  type SearchFiltersPayload,
} from '@apex/automation-core';
import { ForbiddenError, NotFoundError, ConflictError } from '@apex/shared-errors';
import type {
  RunRecord,
  RunStore,
  TaskDispatcher,
  EventPublisher,
  IdempotencyGuard,
  OwnershipLease,
} from './ports.js';

export interface CoordinatorDeps {
  store: RunStore;
  dispatcher: TaskDispatcher;
  publisher: EventPublisher;
  idempotency: IdempotencyGuard;
  ownership: OwnershipLease;
  /** UUID factory (injected for deterministic tests). */
  newId: () => string;
  clock: () => Date;
}

export interface StartRunInput {
  runId: string;
  userId: string;
  tenantId: string;
  mode: RunMode;
  platforms: PlatformKey[];
  filters: SearchFiltersPayload;
  /** Command idempotency key (e.g. the API Idempotency-Key header). */
  commandKey: string;
  dryRun?: boolean;
}

export class RunCoordinator {
  constructor(private readonly deps: CoordinatorDeps) {}

  private assertOwner(userId: string): void {
    if (!this.deps.ownership.owns(userId)) {
      throw new ForbiddenError('Run is owned by a different orchestrator shard', { userId });
    }
  }

  /**
   * Start a new run: build the plan, persist it, then dispatch the first stage's
   * discovery task(s) per the dispatch policy. Idempotent on `commandKey`.
   */
  async startRun(input: StartRunInput): Promise<{ created: boolean; plan: RunPlan }> {
    this.assertOwner(input.userId);
    if (!(await this.deps.idempotency.firstSeen(input.commandKey))) {
      const existing = await this.deps.store.loadForUpdate(input.runId);
      if (existing) return { created: false, plan: existing.plan };
    }
    const plan = planRun(input.mode, input.platforms);
    if (plan.stages.length === 0) {
      throw new ConflictError('Run has no valid platform stages', { platforms: input.platforms });
    }
    const stageIds: Record<string, string> = {};
    for (const stage of plan.stages) stageIds[stage.platformKey] = this.deps.newId();
    const state: RunState = { status: 'pending', control: 'run' };
    const record: RunRecord = {
      runId: input.runId,
      userId: input.userId,
      tenantId: input.tenantId,
      mode: input.mode,
      state,
      plan,
      stageIds,
    };
    await this.deps.store.create(record);

    // pending → planning → running, then dispatch.
    await this.advance(record, { kind: 'plan' });
    await this.advance(record, { kind: 'planned' });
    await this.dispatchReady(record, input.filters, input.dryRun ?? false);
    return { created: true, plan: record.plan };
  }

  /** Apply a state-machine event to a loaded record, persisting + publishing. */
  private async advance(record: RunRecord, event: RunEventInput): Promise<boolean> {
    const result = reduce(record.state, event);
    if (!result.ok) return false; // illegal transitions are ignored (idempotent)
    record.state = result.next;
    await this.deps.store.save(record);
    await this.deps.publisher.publishRunEvent(record.runId, record.tenantId, {
      kind: 'state',
      status: record.state.status,
      control: record.state.control,
      at: this.deps.clock().toISOString(),
    });
    return true;
  }

  /** Dispatch discovery tasks for stages the dispatch policy says are ready. */
  private async dispatchReady(record: RunRecord, filters: SearchFiltersPayload, dryRun: boolean): Promise<void> {
    if (record.state.control !== 'run' || record.state.status !== 'running') return;
    const decision = nextDispatch(record.plan);
    if (decision.action !== 'dispatch') return;
    for (const stage of decision.stages) {
      record.plan = updateStageStatus(record.plan, stage.platformKey, 'running');
      await this.deps.dispatcher.dispatchDiscovery({
        kind: 'discovery',
        runId: record.runId,
        stageId: this.stageId(record, stage.platformKey),
        userId: record.userId,
        tenantId: record.tenantId,
        platformKey: stage.platformKey,
        profile: 'STRICT_DEFAULT',
        attempt: 0,
        dryRun,
        filters,
        idempotencyKey: `disc:${record.runId}:${stage.platformKey}`,
      });
    }
    await this.deps.store.save(record);
  }

  /**
   * Handle a stage completion reported by a worker. Advances the plan, dispatches
   * the next stage (single mode) or completes the run. Idempotent on eventKey.
   */
  async onStageDone(input: {
    runId: string;
    platformKey: PlatformKey;
    status: Extract<StageStatus, 'done' | 'failed' | 'skipped'>;
    filters: SearchFiltersPayload;
    eventKey: string;
  }): Promise<void> {
    const record = await this.deps.store.loadForUpdate(input.runId);
    if (!record) throw new NotFoundError('Run not found', { runId: input.runId });
    this.assertOwner(record.userId);
    if (!(await this.deps.idempotency.firstSeen(input.eventKey))) return; // replay

    record.plan = updateStageStatus(record.plan, input.platformKey, input.status);
    await this.deps.store.save(record);

    const decision = nextDispatch(record.plan);
    if (decision.action === 'complete') {
      const outcome = runOutcome(record.plan);
      await this.advance(record, outcome === 'failed' ? { kind: 'fail', reason: 'all-stages-failed' } : { kind: 'stage.done.all' });
      return;
    }
    if (decision.action === 'dispatch') {
      await this.dispatchReady(record, input.filters, false);
    }
    // 'wait' → nothing to do; a later stage completion will advance.
  }

  /** Pause: in-flight tasks complete; the run halts at the next clean boundary. */
  async pause(runId: string, commandKey: string): Promise<void> {
    const record = await this.deps.store.loadForUpdate(runId);
    if (!record) throw new NotFoundError('Run not found', { runId });
    this.assertOwner(record.userId);
    if (!(await this.deps.idempotency.firstSeen(commandKey))) return;
    await this.advance(record, { kind: 'pause' });
  }

  /** Worker acked that its in-flight task finished after a pause request. */
  async onPauseAcked(runId: string): Promise<void> {
    const record = await this.deps.store.loadForUpdate(runId);
    if (!record) return;
    this.assertOwner(record.userId);
    await this.advance(record, { kind: 'pause.acked' });
  }

  /** Resume a paused run and re-dispatch ready stages. */
  async resume(runId: string, filters: SearchFiltersPayload, commandKey: string): Promise<void> {
    const record = await this.deps.store.loadForUpdate(runId);
    if (!record) throw new NotFoundError('Run not found', { runId });
    this.assertOwner(record.userId);
    if (!(await this.deps.idempotency.firstSeen(commandKey))) return;
    if (await this.advance(record, { kind: 'resume' })) {
      await this.dispatchReady(record, filters, false);
    }
  }

  /** Stop: in-flight tasks complete, then the run is terminal. */
  async stop(runId: string, commandKey: string): Promise<void> {
    const record = await this.deps.store.loadForUpdate(runId);
    if (!record) throw new NotFoundError('Run not found', { runId });
    this.assertOwner(record.userId);
    if (!(await this.deps.idempotency.firstSeen(commandKey))) return;
    await this.advance(record, { kind: 'stop' });
  }

  async onStopAcked(runId: string): Promise<void> {
    const record = await this.deps.store.loadForUpdate(runId);
    if (!record) return;
    this.assertOwner(record.userId);
    await this.advance(record, { kind: 'stop.acked' });
  }

  /**
   * Recovery: on restart, re-derive in-flight runs from the store and re-dispatch
   * any stages that were 'running' but never reported completion. Because tasks
   * carry idempotency keys, re-dispatch cannot create duplicate applications.
   */
  async recoverRun(runId: string, filters: SearchFiltersPayload): Promise<{ redispatched: number }> {
    const record = await this.deps.store.loadForUpdate(runId);
    if (!record) throw new NotFoundError('Run not found', { runId });
    this.assertOwner(record.userId);
    if (record.state.status !== 'running') return { redispatched: 0 };

    let redispatched = 0;
    for (const stage of record.plan.stages) {
      if (stage.status === 'running') {
        await this.deps.dispatcher.dispatchDiscovery({
          kind: 'discovery',
          runId: record.runId,
          stageId: this.stageId(record, stage.platformKey),
          userId: record.userId,
          tenantId: record.tenantId,
          platformKey: stage.platformKey,
          profile: 'STRICT_DEFAULT',
          attempt: 0,
          dryRun: false,
          filters,
          idempotencyKey: `disc:${record.runId}:${stage.platformKey}`,
        });
        redispatched++;
      }
    }
    return { redispatched };
  }

  /** Stage id for a platform — a real UUID assigned at run creation. */
  private stageId(record: RunRecord, platform: PlatformKey): string {
    const id = record.stageIds[platform];
    if (id === undefined) {
      throw new ConflictError('No stage id for platform', { runId: record.runId, platform });
    }
    return id;
  }
}
