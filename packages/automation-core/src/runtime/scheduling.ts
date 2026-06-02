// Scheduling primitives for apps/scheduler: interval-based next-fire computation,
// due detection, deterministic jitter, and a fencing-token leader-election lease
// policy. All pure & deterministic (clock/values injected) → unit-testable with
// no timers, Redis, or Postgres.
//
// Reference: docs/architecture/04-backend-design.md §4 (scheduler service),
//            docs/audit/03-implementation-plan.md (Phase 2 scheduler).

/** A recurring schedule expressed as a fixed interval (cron is normalized to this upstream). */
export interface IntervalSchedule {
  scheduleId: string;
  /** Fire every N milliseconds. */
  intervalMs: number;
  /** Epoch ms of the last fire (0 if never). */
  lastFiredAtMs: number;
  /** Whether the schedule is active. */
  enabled: boolean;
  /** Optional max jitter (ms) added to avoid thundering-herd at boundaries. */
  jitterMs?: number | undefined;
}

/** Deterministic jitter in [0, jitterMs) derived from the schedule id. */
export function deterministicJitter(scheduleId: string, jitterMs: number): number {
  if (jitterMs <= 0) return 0;
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < scheduleId.length; i++) {
    h ^= scheduleId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % jitterMs;
}

/** Next scheduled fire time (epoch ms), including deterministic jitter. */
export function nextFireAt(schedule: IntervalSchedule): number {
  const base = (schedule.lastFiredAtMs > 0 ? schedule.lastFiredAtMs : 0) + schedule.intervalMs;
  return base + deterministicJitter(schedule.scheduleId, schedule.jitterMs ?? 0);
}

/** True when the schedule is enabled and its next fire time is at or before now. */
export function isDue(schedule: IntervalSchedule, nowMs: number): boolean {
  if (!schedule.enabled) return false;
  return nowMs >= nextFireAt(schedule);
}

/** Filter+sort the schedules that are due at `nowMs` (earliest next-fire first). */
export function dueSchedules(schedules: IntervalSchedule[], nowMs: number): IntervalSchedule[] {
  return schedules
    .filter((s) => isDue(s, nowMs))
    .sort((a, b) => nextFireAt(a) - nextFireAt(b));
}

// ---------------------------------------------------------------------------
// Leader election via fencing-token lease (single-active-scheduler guarantee).
// ---------------------------------------------------------------------------

export interface LeaderLease {
  /** The instance that currently holds the lease. */
  holder: string;
  /** Monotonic fencing token, incremented on every acquisition. */
  fencingToken: number;
  /** Epoch ms the lease expires. */
  expiresAtMs: number;
}

export type LeaseDecision =
  | { action: 'acquire'; lease: LeaderLease }
  | { action: 'renew'; lease: LeaderLease }
  | { action: 'deny'; heldBy: string };

/**
 * Decide whether `instanceId` may acquire/renew the leader lease at `nowMs`.
 *  - No current lease, or it has expired → acquire (token + 1).
 *  - Held by us and not expired → renew (same token, extended expiry).
 *  - Held by someone else and not expired → deny.
 *
 * The caller commits the decision with a compare-and-set on the fencing token in
 * Redis; a stale holder whose token is behind is safely fenced out.
 */
export function evaluateLease(
  current: LeaderLease | null,
  instanceId: string,
  nowMs: number,
  ttlMs: number,
): LeaseDecision {
  if (current === null || nowMs >= current.expiresAtMs) {
    const token = (current?.fencingToken ?? 0) + 1;
    return {
      action: 'acquire',
      lease: { holder: instanceId, fencingToken: token, expiresAtMs: nowMs + ttlMs },
    };
  }
  if (current.holder === instanceId) {
    return {
      action: 'renew',
      lease: { holder: instanceId, fencingToken: current.fencingToken, expiresAtMs: nowMs + ttlMs },
    };
  }
  return { action: 'deny', heldBy: current.holder };
}

/** True when `token` is current (>=) relative to the last-seen token (fencing). */
export function isFenced(lastSeenToken: number, incomingToken: number): boolean {
  // An action is fenced OUT (rejected) when its token is older than the last seen.
  return incomingToken < lastSeenToken;
}
