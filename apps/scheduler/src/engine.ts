// SchedulerEngine — the leader-only tick loop. On each tick it:
//   1. tries to acquire/renew the leader lease (only the leader proceeds),
//   2. finds due recurring schedules + maintenance jobs,
//   3. dispatches schedule-fire / maintenance tasks,
//   4. records the fire time so the next interval is computed correctly.
//
// All logic is pure given injected ports + clock → unit-testable with no Redis.
//
// Reference: docs/architecture/04-backend-design.md §4 (scheduler service),
//            docs/audit/03-implementation-plan.md (Phase 2 scheduler + maintenance crons).

import {
  dueSchedules,
  evaluateLease,
  type IntervalSchedule,
  type LeaderLease,
  type ScheduleFireTask,
} from '@apex/automation-core';

/** Persistent store for recurring schedules + the leader lease. */
export interface ScheduleStore {
  /** All active recurring schedules (saved searches, alerts). */
  listSchedules(): Promise<IntervalSchedule[]>;
  /** Record that a schedule fired at `firedAtMs`. */
  markFired(scheduleId: string, firedAtMs: number): Promise<void>;
  /** Read the current leader lease (null when none). */
  readLease(): Promise<LeaderLease | null>;
  /** Compare-and-set the lease; returns true when committed (fencing-safe). */
  commitLease(expected: LeaderLease | null, next: LeaderLease): Promise<boolean>;
  /** Template/saved-search → run materialization metadata for a schedule. */
  scheduleMeta(scheduleId: string): Promise<{ userId: string; tenantId: string; templateId: string } | null>;
}

/** Dispatches schedule-fire tasks to the orchestrator queue (q:schedule.fire). */
export interface ScheduleDispatcher {
  dispatchScheduleFire(task: ScheduleFireTask): Promise<void>;
}

/** A maintenance job: a named recurring system task with its own interval. */
export interface MaintenanceJob {
  name: string;
  schedule: IntervalSchedule;
  run(nowMs: number): Promise<void>;
}

export interface SchedulerEngineDeps {
  store: ScheduleStore;
  dispatcher: ScheduleDispatcher;
  instanceId: string;
  leaseTtlMs: number;
  /** Maintenance jobs (session refresh sweep, recovery sweep, audit-chain verify…). */
  maintenance: MaintenanceJob[];
  clock: () => number;
}

export interface TickResult {
  isLeader: boolean;
  firedSchedules: string[];
  ranMaintenance: string[];
}

export class SchedulerEngine {
  constructor(private readonly deps: SchedulerEngineDeps) {}

  /**
   * Try to become/stay leader for this tick. Returns true only if the lease was
   * committed to us (fencing-safe compare-and-set). A losing instance does no work.
   */
  private async ensureLeadership(nowMs: number): Promise<boolean> {
    const current = await this.deps.store.readLease();
    const decision = evaluateLease(current, this.deps.instanceId, nowMs, this.deps.leaseTtlMs);
    if (decision.action === 'deny') return false;
    return this.deps.store.commitLease(current, decision.lease);
  }

  /** Run one scheduler tick. Idempotent and safe to call from a fixed interval. */
  async tick(): Promise<TickResult> {
    const nowMs = this.deps.clock();
    const isLeader = await this.ensureLeadership(nowMs);
    if (!isLeader) {
      return { isLeader: false, firedSchedules: [], ranMaintenance: [] };
    }

    // 1. Recurring user schedules (saved searches / alerts) → schedule-fire tasks.
    const schedules = await this.deps.store.listSchedules();
    const due = dueSchedules(schedules, nowMs);
    const firedSchedules: string[] = [];
    for (const s of due) {
      const meta = await this.deps.store.scheduleMeta(s.scheduleId);
      if (!meta) continue;
      await this.deps.dispatcher.dispatchScheduleFire({
        kind: 'schedule_fire',
        scheduleId: s.scheduleId,
        userId: meta.userId,
        tenantId: meta.tenantId,
        templateId: meta.templateId,
        firedAt: new Date(nowMs).toISOString(),
      });
      await this.deps.store.markFired(s.scheduleId, nowMs);
      firedSchedules.push(s.scheduleId);
    }

    // 2. System maintenance jobs (each with its own interval).
    const ranMaintenance: string[] = [];
    for (const job of this.deps.maintenance) {
      if (job.schedule.enabled && nowMs >= job.schedule.lastFiredAtMs + job.schedule.intervalMs) {
        await job.run(nowMs);
        job.schedule.lastFiredAtMs = nowMs;
        ranMaintenance.push(job.name);
      }
    }

    return { isLeader: true, firedSchedules, ranMaintenance };
  }
}
