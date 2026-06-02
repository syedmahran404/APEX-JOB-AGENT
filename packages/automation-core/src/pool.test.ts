import { describe, it, expect } from 'vitest';
import { ConcurrencyGuard, pairKey, DEFAULT_MAX_PAIRS } from './pool.js';

describe('pool/ConcurrencyGuard (worker concurrency policy)', () => {
  it('pairKey is stable per (user, platform)', () => {
    expect(pairKey('u', 'linkedin')).toBe('u:linkedin');
  });

  it('admits a task and reports active stats', () => {
    const g = new ConcurrencyGuard(4);
    expect(g.canAdmit('u1', 'linkedin')).toBe(true);
    g.admit('u1', 'linkedin');
    expect(g.stats()).toEqual({ activeUsers: 1, activePairs: 1, maxPairs: 4 });
  });

  it('never runs two tasks for the same user simultaneously, even across platforms', () => {
    const g = new ConcurrencyGuard(4);
    g.admit('u1', 'linkedin');
    expect(g.canAdmit('u1', 'naukri')).toBe(false);
    expect(g.rejectionReason('u1', 'naukri')).toBe('user-already-active');
  });

  it('allows different users in parallel up to maxPairs', () => {
    const g = new ConcurrencyGuard(2);
    g.admit('u1', 'linkedin');
    g.admit('u2', 'naukri');
    expect(g.canAdmit('u3', 'indeed')).toBe(false);
    expect(g.rejectionReason('u3', 'indeed')).toBe('worker-at-capacity');
  });

  it('releases slots so a new task can be admitted', () => {
    const g = new ConcurrencyGuard(1);
    g.admit('u1', 'linkedin');
    expect(g.canAdmit('u2', 'naukri')).toBe(false);
    g.release('u1', 'linkedin');
    expect(g.canAdmit('u2', 'naukri')).toBe(true);
  });

  it('admit throws when a rule would be violated', () => {
    const g = new ConcurrencyGuard(4);
    g.admit('u1', 'linkedin');
    expect(() => g.admit('u1', 'indeed')).toThrowError(/user-already-active/);
  });

  it('defaults to DEFAULT_MAX_PAIRS', () => {
    expect(new ConcurrencyGuard().maxPairs).toBe(DEFAULT_MAX_PAIRS);
  });
});
