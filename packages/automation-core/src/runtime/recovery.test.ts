import { describe, it, expect } from 'vitest';
import { planResume, mayApply, summarizeProgress, type RunProgressSnapshot } from './recovery.js';

function snapshot(jobs: RunProgressSnapshot['jobs']): RunProgressSnapshot {
  return { runId: 'r-1', userId: 'u-1', currentPlatform: 'linkedin', jobs };
}

describe('runtime/recovery (state recovery + duplicate prevention)', () => {
  it('re-dispatches pending and in_progress; never terminal jobs', () => {
    const snap = snapshot([
      { jobExternalId: 'a', canonicalKey: 'ka', outcome: 'completed' },
      { jobExternalId: 'b', canonicalKey: 'kb', outcome: 'in_progress', lastStep: 'fill' },
      { jobExternalId: 'c', canonicalKey: 'kc', outcome: 'pending' },
      { jobExternalId: 'd', canonicalKey: 'kd', outcome: 'failed' },
      { jobExternalId: 'e', canonicalKey: 'ke', outcome: 'skipped' },
    ]);
    const plan = planResume(snap);
    expect(plan.toDispatch.map((j) => j.jobExternalId).sort()).toEqual(['b', 'c']);
    expect(plan.alreadyTerminal.map((j) => j.jobExternalId).sort()).toEqual(['a', 'd', 'e']);
  });

  it('skip sets include all terminal external ids', () => {
    const snap = snapshot([
      { jobExternalId: 'a', canonicalKey: 'ka', outcome: 'completed' },
      { jobExternalId: 'd', canonicalKey: 'kd', outcome: 'failed' },
    ]);
    const plan = planResume(snap);
    expect(plan.skipExternalIds.has('a')).toBe(true);
    expect(plan.skipExternalIds.has('d')).toBe(true);
  });

  it('only completed applications block the canonical key (failed may retry elsewhere)', () => {
    const snap = snapshot([
      { jobExternalId: 'a', canonicalKey: 'shared', outcome: 'completed' },
      { jobExternalId: 'b', canonicalKey: 'failedkey', outcome: 'failed' },
    ]);
    const plan = planResume(snap);
    expect(plan.skipCanonicalKeys.has('shared')).toBe(true);
    expect(plan.skipCanonicalKeys.has('failedkey')).toBe(false);
  });

  describe('mayApply guards against duplicates', () => {
    const snap = snapshot([
      { jobExternalId: 'applied-1', canonicalKey: 'role-x', outcome: 'completed' },
    ]);
    const plan = planResume(snap);

    it('blocks an already-applied external id', () => {
      const r = mayApply({ jobExternalId: 'applied-1', canonicalKey: 'other' }, plan);
      expect(r.allowed).toBe(false);
      expect(r.reason).toBe('external_id_applied');
    });

    it('blocks the same role on another platform via canonical key', () => {
      const r = mayApply({ jobExternalId: 'nk-999', canonicalKey: 'role-x' }, plan);
      expect(r.allowed).toBe(false);
      expect(r.reason).toBe('canonical_applied');
    });

    it('allows a genuinely new job', () => {
      const r = mayApply({ jobExternalId: 'new-1', canonicalKey: 'role-y' }, plan);
      expect(r.allowed).toBe(true);
    });
  });

  it('summarizeProgress counts outcomes', () => {
    const snap = snapshot([
      { jobExternalId: 'a', canonicalKey: 'ka', outcome: 'completed' },
      { jobExternalId: 'b', canonicalKey: 'kb', outcome: 'completed' },
      { jobExternalId: 'c', canonicalKey: 'kc', outcome: 'pending' },
    ]);
    expect(summarizeProgress(snap)).toEqual({ completed: 2, failed: 0, skipped: 0, in_progress: 0, pending: 1 });
  });
});
