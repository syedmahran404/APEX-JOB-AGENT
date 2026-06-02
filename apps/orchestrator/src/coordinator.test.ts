import { describe, it, expect, beforeEach } from 'vitest';
import type { DiscoveryTask, ApplyTask, SessionRefreshTask, SearchFiltersPayload } from '@apex/automation-core';
import { RunCoordinator } from './coordinator.js';
import type { RunRecord, RunStore, TaskDispatcher, EventPublisher, IdempotencyGuard, OwnershipLease } from './ports.js';

// ---- In-memory fakes for every port ----
class FakeStore implements RunStore {
  records = new Map<string, RunRecord>();
  loadForUpdate(runId: string): Promise<RunRecord | null> {
    const r = this.records.get(runId);
    // Return a deep-ish clone so the coordinator's mutations are explicit via save().
    return Promise.resolve(r ? structuredClone(r) : null);
  }
  save(record: RunRecord): Promise<void> {
    this.records.set(record.runId, structuredClone(record));
    return Promise.resolve();
  }
  create(record: RunRecord): Promise<void> {
    this.records.set(record.runId, structuredClone(record));
    return Promise.resolve();
  }
}

class FakeDispatcher implements TaskDispatcher {
  discovery: DiscoveryTask[] = [];
  apply: ApplyTask[] = [];
  refresh: SessionRefreshTask[] = [];
  dispatchDiscovery(t: DiscoveryTask): Promise<void> {
    this.discovery.push(t);
    return Promise.resolve();
  }
  dispatchApply(t: ApplyTask): Promise<void> {
    this.apply.push(t);
    return Promise.resolve();
  }
  dispatchSessionRefresh(t: SessionRefreshTask): Promise<void> {
    this.refresh.push(t);
    return Promise.resolve();
  }
}

class FakePublisher implements EventPublisher {
  events: Array<{ runId: string; event: Record<string, unknown> }> = [];
  publishRunEvent(runId: string, _tenantId: string, event: Record<string, unknown>): Promise<void> {
    this.events.push({ runId, event });
    return Promise.resolve();
  }
}

class FakeIdempotency implements IdempotencyGuard {
  seen = new Set<string>();
  firstSeen(key: string): Promise<boolean> {
    if (this.seen.has(key)) return Promise.resolve(false);
    this.seen.add(key);
    return Promise.resolve(true);
  }
}

class FakeOwnership implements OwnershipLease {
  constructor(private readonly ownedUser: string | null = null) {}
  owns(userId: string): boolean {
    return this.ownedUser === null || this.ownedUser === userId;
  }
}

const FILTERS: SearchFiltersPayload = { query: 'backend engineer' };

function makeCoordinator(ownership = new FakeOwnership()) {
  const store = new FakeStore();
  const dispatcher = new FakeDispatcher();
  const publisher = new FakePublisher();
  const idempotency = new FakeIdempotency();
  let idCounter = 0;
  const coordinator = new RunCoordinator({
    store,
    dispatcher,
    publisher,
    idempotency,
    ownership,
    newId: () => `id-${String(++idCounter)}`,
    clock: () => new Date('2026-06-02T12:00:00.000Z'),
  });
  return { coordinator, store, dispatcher, publisher, idempotency };
}

describe('RunCoordinator', () => {
  let ctx: ReturnType<typeof makeCoordinator>;
  beforeEach(() => {
    ctx = makeCoordinator();
  });

  it('startRun (single mode) plans, transitions to running, dispatches first stage only', async () => {
    const res = await ctx.coordinator.startRun({
      runId: 'run-1',
      userId: 'u-1',
      tenantId: 't-1',
      mode: 'single',
      platforms: ['linkedin', 'naukri'],
      filters: FILTERS,
      commandKey: 'cmd-1',
    });
    expect(res.created).toBe(true);
    const rec = ctx.store.records.get('run-1')!;
    expect(rec.state.status).toBe('running');
    // Single mode → only the first stage dispatched.
    expect(ctx.dispatcher.discovery).toHaveLength(1);
    expect(ctx.dispatcher.discovery[0]?.platformKey).toBe('linkedin');
    expect(ctx.dispatcher.discovery[0]?.stageId).toMatch(/^id-/);
    // first stage marked running
    expect(rec.plan.stages.find((s) => s.platformKey === 'linkedin')?.status).toBe('running');
    expect(rec.plan.stages.find((s) => s.platformKey === 'naukri')?.status).toBe('pending');
  });

  it('startRun (multi mode) fans out discovery to all stages', async () => {
    await ctx.coordinator.startRun({
      runId: 'run-2',
      userId: 'u-1',
      tenantId: 't-1',
      mode: 'multi',
      platforms: ['linkedin', 'naukri', 'indeed'],
      filters: FILTERS,
      commandKey: 'cmd-2',
    });
    expect(ctx.dispatcher.discovery).toHaveLength(3);
  });

  it('startRun is idempotent on commandKey (replay does not create a second run)', async () => {
    const input = {
      runId: 'run-3',
      userId: 'u-1',
      tenantId: 't-1',
      mode: 'single' as const,
      platforms: ['linkedin' as const],
      filters: FILTERS,
      commandKey: 'cmd-3',
    };
    await ctx.coordinator.startRun(input);
    const before = ctx.dispatcher.discovery.length;
    const res2 = await ctx.coordinator.startRun(input);
    expect(res2.created).toBe(false);
    expect(ctx.dispatcher.discovery.length).toBe(before); // no extra dispatch
  });

  it('rejects platforms that yield no stages', async () => {
    await expect(
      ctx.coordinator.startRun({
        runId: 'run-x',
        userId: 'u-1',
        tenantId: 't-1',
        mode: 'single',
        platforms: [],
        filters: FILTERS,
        commandKey: 'cmd-x',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('onStageDone advances single-mode run to the next stage', async () => {
    await ctx.coordinator.startRun({
      runId: 'run-4',
      userId: 'u-1',
      tenantId: 't-1',
      mode: 'single',
      platforms: ['linkedin', 'naukri'],
      filters: FILTERS,
      commandKey: 'cmd-4',
    });
    await ctx.coordinator.onStageDone({
      runId: 'run-4',
      platformKey: 'linkedin',
      status: 'done',
      filters: FILTERS,
      eventKey: 'evt-1',
    });
    // naukri now dispatched.
    expect(ctx.dispatcher.discovery.map((d) => d.platformKey)).toEqual(['linkedin', 'naukri']);
  });

  it('completes the run when all stages are done', async () => {
    await ctx.coordinator.startRun({
      runId: 'run-5',
      userId: 'u-1',
      tenantId: 't-1',
      mode: 'single',
      platforms: ['linkedin'],
      filters: FILTERS,
      commandKey: 'cmd-5',
    });
    await ctx.coordinator.onStageDone({
      runId: 'run-5',
      platformKey: 'linkedin',
      status: 'done',
      filters: FILTERS,
      eventKey: 'evt-2',
    });
    expect(ctx.store.records.get('run-5')!.state.status).toBe('done');
  });

  it('fails the run when all stages failed', async () => {
    await ctx.coordinator.startRun({
      runId: 'run-6',
      userId: 'u-1',
      tenantId: 't-1',
      mode: 'single',
      platforms: ['linkedin'],
      filters: FILTERS,
      commandKey: 'cmd-6',
    });
    await ctx.coordinator.onStageDone({
      runId: 'run-6',
      platformKey: 'linkedin',
      status: 'failed',
      filters: FILTERS,
      eventKey: 'evt-3',
    });
    expect(ctx.store.records.get('run-6')!.state.status).toBe('failed');
  });

  it('onStageDone is idempotent on eventKey (replay is a no-op)', async () => {
    await ctx.coordinator.startRun({
      runId: 'run-7',
      userId: 'u-1',
      tenantId: 't-1',
      mode: 'single',
      platforms: ['linkedin', 'naukri'],
      filters: FILTERS,
      commandKey: 'cmd-7',
    });
    await ctx.coordinator.onStageDone({ runId: 'run-7', platformKey: 'linkedin', status: 'done', filters: FILTERS, eventKey: 'evt-dup' });
    const after1 = ctx.dispatcher.discovery.length;
    await ctx.coordinator.onStageDone({ runId: 'run-7', platformKey: 'linkedin', status: 'done', filters: FILTERS, eventKey: 'evt-dup' });
    expect(ctx.dispatcher.discovery.length).toBe(after1); // replay ignored
  });

  it('pause → pause.acked transitions running → paused; resume re-dispatches', async () => {
    await ctx.coordinator.startRun({
      runId: 'run-8',
      userId: 'u-1',
      tenantId: 't-1',
      mode: 'single',
      platforms: ['linkedin', 'naukri'],
      filters: FILTERS,
      commandKey: 'cmd-8',
    });
    await ctx.coordinator.pause('run-8', 'pause-1');
    expect(ctx.store.records.get('run-8')!.state.control).toBe('pause');
    await ctx.coordinator.onPauseAcked('run-8');
    expect(ctx.store.records.get('run-8')!.state.status).toBe('paused');
    await ctx.coordinator.resume('run-8', FILTERS, 'resume-1');
    expect(ctx.store.records.get('run-8')!.state.status).toBe('running');
  });

  it('stop → stop.acked transitions to stopped', async () => {
    await ctx.coordinator.startRun({
      runId: 'run-9',
      userId: 'u-1',
      tenantId: 't-1',
      mode: 'single',
      platforms: ['linkedin'],
      filters: FILTERS,
      commandKey: 'cmd-9',
    });
    await ctx.coordinator.stop('run-9', 'stop-1');
    expect(ctx.store.records.get('run-9')!.state.control).toBe('stop');
    await ctx.coordinator.onStopAcked('run-9');
    expect(ctx.store.records.get('run-9')!.state.status).toBe('stopped');
  });

  it('recoverRun re-dispatches running stages (idempotency keys prevent duplicates)', async () => {
    await ctx.coordinator.startRun({
      runId: 'run-10',
      userId: 'u-1',
      tenantId: 't-1',
      mode: 'multi',
      platforms: ['linkedin', 'naukri'],
      filters: FILTERS,
      commandKey: 'cmd-10',
    });
    const before = ctx.dispatcher.discovery.length; // 2 running
    const res = await ctx.coordinator.recoverRun('run-10', FILTERS);
    expect(res.redispatched).toBe(2);
    // Re-dispatched discovery tasks reuse the same idempotency key.
    const keys = ctx.dispatcher.discovery.slice(before).map((d) => d.idempotencyKey);
    expect(keys).toContain('disc:run-10:linkedin');
  });

  it('rejects commands for runs owned by a different shard', async () => {
    const owned = makeCoordinator(new FakeOwnership('someone-else'));
    await expect(
      owned.coordinator.startRun({
        runId: 'run-11',
        userId: 'u-1',
        tenantId: 't-1',
        mode: 'single',
        platforms: ['linkedin'],
        filters: FILTERS,
        commandKey: 'cmd-11',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('publishes a run-state event on each transition', async () => {
    await ctx.coordinator.startRun({
      runId: 'run-12',
      userId: 'u-1',
      tenantId: 't-1',
      mode: 'single',
      platforms: ['linkedin'],
      filters: FILTERS,
      commandKey: 'cmd-12',
    });
    const statuses = ctx.publisher.events.map((e) => e.event.status);
    expect(statuses).toContain('planning');
    expect(statuses).toContain('running');
  });
});
