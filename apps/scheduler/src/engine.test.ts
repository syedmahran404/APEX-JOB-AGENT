import { describe, it, expect } from 'vitest';
import type { IntervalSchedule, LeaderLease, ScheduleFireTask } from '@apex/automation-core';
import { SchedulerEngine, type ScheduleStore, type ScheduleDispatcher, type MaintenanceJob } from './engine.js';

class FakeStore implements ScheduleStore {
  schedules: IntervalSchedule[] = [];
  lease: LeaderLease | null = null;
  fired: Array<{ id: string; at: number }> = [];
  meta = new Map<string, { userId: string; tenantId: string; templateId: string }>();

  listSchedules(): Promise<IntervalSchedule[]> {
    return Promise.resolve(this.schedules);
  }
  markFired(scheduleId: string, firedAtMs: number): Promise<void> {
    this.fired.push({ id: scheduleId, at: firedAtMs });
    const s = this.schedules.find((x) => x.scheduleId === scheduleId);
    if (s) s.lastFiredAtMs = firedAtMs;
    return Promise.resolve();
  }
  readLease(): Promise<LeaderLease | null> {
    return Promise.resolve(this.lease);
  }
  commitLease(_expected: LeaderLease | null, next: LeaderLease): Promise<boolean> {
    this.lease = next;
    return Promise.resolve(true);
  }
  scheduleMeta(scheduleId: string): Promise<{ userId: string; tenantId: string; templateId: string } | null> {
    return Promise.resolve(this.meta.get(scheduleId) ?? null);
  }
}

class FakeDispatcher implements ScheduleDispatcher {
  fired: ScheduleFireTask[] = [];
  dispatchScheduleFire(task: ScheduleFireTask): Promise<void> {
    this.fired.push(task);
    return Promise.resolve();
  }
}

function sched(id: string, intervalMs: number, lastFiredAtMs = 0): IntervalSchedule {
  return { scheduleId: id, intervalMs, lastFiredAtMs, enabled: true };
}

function makeEngine(opts?: { instanceId?: string; maintenance?: MaintenanceJob[]; now?: () => number }) {
  const store = new FakeStore();
  const dispatcher = new FakeDispatcher();
  const engine = new SchedulerEngine({
    store,
    dispatcher,
    instanceId: opts?.instanceId ?? 'inst-1',
    leaseTtlMs: 30_000,
    maintenance: opts?.maintenance ?? [],
    clock: opts?.now ?? ((): number => 100_000),
  });
  return { engine, store, dispatcher };
}

describe('SchedulerEngine', () => {
  it('acquires leadership and fires a due schedule', async () => {
    const { engine, store, dispatcher } = makeEngine();
    store.schedules = [sched('s1', 1000, 0)];
    store.meta.set('s1', { userId: 'u-1', tenantId: 't-1', templateId: 'tpl-1' });
    const res = await engine.tick();
    expect(res.isLeader).toBe(true);
    expect(res.firedSchedules).toEqual(['s1']);
    expect(dispatcher.fired).toHaveLength(1);
    expect(dispatcher.fired[0]?.scheduleId).toBe('s1');
    expect(store.fired[0]?.id).toBe('s1');
  });

  it('does not fire a schedule that is not yet due', async () => {
    const { engine, store, dispatcher } = makeEngine({ now: () => 100_000 });
    store.schedules = [sched('s1', 1000, 99_500)]; // next fire at 100_500 > now
    store.meta.set('s1', { userId: 'u-1', tenantId: 't-1', templateId: 'tpl-1' });
    const res = await engine.tick();
    expect(res.firedSchedules).toEqual([]);
    expect(dispatcher.fired).toHaveLength(0);
  });

  it('a non-leader instance does no work', async () => {
    const { engine, store, dispatcher } = makeEngine({ instanceId: 'inst-2', now: () => 100_000 });
    // Live lease held by someone else.
    store.lease = { holder: 'inst-1', fencingToken: 5, expiresAtMs: 200_000 };
    store.schedules = [sched('s1', 1000, 0)];
    store.meta.set('s1', { userId: 'u-1', tenantId: 't-1', templateId: 'tpl-1' });
    const res = await engine.tick();
    expect(res.isLeader).toBe(false);
    expect(dispatcher.fired).toHaveLength(0);
  });

  it('skips schedules without materialization metadata', async () => {
    const { engine, store, dispatcher } = makeEngine();
    store.schedules = [sched('orphan', 1000, 0)]; // no meta entry
    const res = await engine.tick();
    expect(res.firedSchedules).toEqual([]);
    expect(dispatcher.fired).toHaveLength(0);
  });

  it('runs due maintenance jobs and records the run', async () => {
    let ran = 0;
    const job: MaintenanceJob = {
      name: 'session-refresh-sweep',
      schedule: sched('m1', 1000, 0),
      run: (): Promise<void> => {
        ran++;
        return Promise.resolve();
      },
    };
    const { engine } = makeEngine({ maintenance: [job], now: () => 100_000 });
    const res = await engine.tick();
    expect(res.ranMaintenance).toContain('session-refresh-sweep');
    expect(ran).toBe(1);
    // Second tick at the same time → not due again (lastFired updated).
    const res2 = await engine.tick();
    expect(res2.ranMaintenance).toEqual([]);
  });

  it('fires multiple due schedules in one tick', async () => {
    const { engine, store, dispatcher } = makeEngine();
    store.schedules = [sched('s1', 1000, 0), sched('s2', 1000, 0)];
    store.meta.set('s1', { userId: 'u-1', tenantId: 't-1', templateId: 'tpl-1' });
    store.meta.set('s2', { userId: 'u-2', tenantId: 't-1', templateId: 'tpl-2' });
    const res = await engine.tick();
    expect(res.firedSchedules.sort()).toEqual(['s1', 's2']);
    expect(dispatcher.fired).toHaveLength(2);
  });
});
