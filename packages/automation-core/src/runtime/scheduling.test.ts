import { describe, it, expect } from 'vitest';
import {
  deterministicJitter,
  nextFireAt,
  isDue,
  dueSchedules,
  evaluateLease,
  isFenced,
  type IntervalSchedule,
  type LeaderLease,
} from './scheduling.js';

function sched(partial: Partial<IntervalSchedule> & { scheduleId: string }): IntervalSchedule {
  return { intervalMs: 60_000, lastFiredAtMs: 0, enabled: true, ...partial };
}

describe('runtime/scheduling — intervals', () => {
  it('deterministicJitter is stable and within [0, jitterMs)', () => {
    const j1 = deterministicJitter('sched-a', 5000);
    const j2 = deterministicJitter('sched-a', 5000);
    expect(j1).toBe(j2);
    expect(j1).toBeGreaterThanOrEqual(0);
    expect(j1).toBeLessThan(5000);
    expect(deterministicJitter('x', 0)).toBe(0);
  });

  it('nextFireAt = lastFired + interval + jitter', () => {
    const s = sched({ scheduleId: 's1', intervalMs: 1000, lastFiredAtMs: 10_000, jitterMs: 0 });
    expect(nextFireAt(s)).toBe(11_000);
  });

  it('isDue true once now >= nextFireAt; false when disabled', () => {
    const s = sched({ scheduleId: 's1', intervalMs: 1000, lastFiredAtMs: 0, jitterMs: 0 });
    expect(isDue(s, 999)).toBe(false);
    expect(isDue(s, 1000)).toBe(true);
    expect(isDue({ ...s, enabled: false }, 5000)).toBe(false);
  });

  it('dueSchedules filters and sorts by next fire', () => {
    const a = sched({ scheduleId: 'a', intervalMs: 1000, lastFiredAtMs: 0, jitterMs: 0 });
    const b = sched({ scheduleId: 'b', intervalMs: 500, lastFiredAtMs: 0, jitterMs: 0 });
    const c = sched({ scheduleId: 'c', intervalMs: 100000, lastFiredAtMs: 0, jitterMs: 0 });
    const due = dueSchedules([a, b, c], 2000);
    expect(due.map((s) => s.scheduleId)).toEqual(['b', 'a']); // c not due; b fires earlier
  });
});

describe('runtime/scheduling — leader election (fencing lease)', () => {
  it('acquires when no current lease (token 1)', () => {
    const d = evaluateLease(null, 'inst-1', 1000, 30_000);
    expect(d.action).toBe('acquire');
    if (d.action === 'acquire') {
      expect(d.lease.fencingToken).toBe(1);
      expect(d.lease.holder).toBe('inst-1');
      expect(d.lease.expiresAtMs).toBe(31_000);
    }
  });

  it('acquires (token+1) when the current lease has expired', () => {
    const current: LeaderLease = { holder: 'old', fencingToken: 7, expiresAtMs: 1000 };
    const d = evaluateLease(current, 'inst-2', 2000, 30_000);
    expect(d.action).toBe('acquire');
    if (d.action === 'acquire') expect(d.lease.fencingToken).toBe(8);
  });

  it('renews for the same holder without bumping the token', () => {
    const current: LeaderLease = { holder: 'inst-1', fencingToken: 3, expiresAtMs: 10_000 };
    const d = evaluateLease(current, 'inst-1', 5000, 30_000);
    expect(d.action).toBe('renew');
    if (d.action === 'renew') {
      expect(d.lease.fencingToken).toBe(3);
      expect(d.lease.expiresAtMs).toBe(35_000);
    }
  });

  it('denies a different instance while the lease is live', () => {
    const current: LeaderLease = { holder: 'inst-1', fencingToken: 3, expiresAtMs: 10_000 };
    const d = evaluateLease(current, 'inst-2', 5000, 30_000);
    expect(d.action).toBe('deny');
    if (d.action === 'deny') expect(d.heldBy).toBe('inst-1');
  });

  it('isFenced rejects stale tokens', () => {
    expect(isFenced(5, 4)).toBe(true); // 4 is older → fenced out
    expect(isFenced(5, 5)).toBe(false);
    expect(isFenced(5, 6)).toBe(false);
  });
});
