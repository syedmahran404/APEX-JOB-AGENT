import { describe, it, expect } from 'vitest';
import {
  planRun,
  nextDispatch,
  updateStageStatus,
  isRunComplete,
  runOutcome,
  CANONICAL_PLATFORM_ORDER,
} from './run-plan.js';

describe('runtime/run-plan', () => {
  it('plans stages in canonical order, dropping unselected platforms', () => {
    const plan = planRun('multi', ['upwork', 'linkedin', 'indeed']);
    expect(plan.stages.map((s) => s.platformKey)).toEqual(['linkedin', 'indeed', 'upwork']);
    expect(plan.stages.every((s) => s.status === 'pending')).toBe(true);
    expect(plan.stages.map((s) => s.ordinal)).toEqual([0, 1, 2]);
  });

  it('canonical order has all 8 platforms with linkedin first', () => {
    expect(CANONICAL_PLATFORM_ORDER).toHaveLength(8);
    expect(CANONICAL_PLATFORM_ORDER[0]).toBe('linkedin');
  });

  describe('single mode dispatch (strict sequential)', () => {
    it('dispatches exactly one pending stage when nothing is running', () => {
      const plan = planRun('single', ['linkedin', 'naukri']);
      const d = nextDispatch(plan);
      expect(d.action).toBe('dispatch');
      if (d.action === 'dispatch') {
        expect(d.stages).toHaveLength(1);
        expect(d.stages[0]?.platformKey).toBe('linkedin');
      }
    });

    it('waits while a stage is running', () => {
      let plan = planRun('single', ['linkedin', 'naukri']);
      plan = updateStageStatus(plan, 'linkedin', 'running');
      expect(nextDispatch(plan).action).toBe('wait');
    });

    it('advances to the next stage after the first completes', () => {
      let plan = planRun('single', ['linkedin', 'naukri']);
      plan = updateStageStatus(plan, 'linkedin', 'done');
      const d = nextDispatch(plan);
      expect(d.action).toBe('dispatch');
      if (d.action === 'dispatch') expect(d.stages[0]?.platformKey).toBe('naukri');
    });
  });

  describe('multi mode dispatch (fan-out)', () => {
    it('dispatches all pending stages at once', () => {
      const plan = planRun('multi', ['linkedin', 'naukri', 'indeed']);
      const d = nextDispatch(plan);
      expect(d.action).toBe('dispatch');
      if (d.action === 'dispatch') expect(d.stages).toHaveLength(3);
    });

    it('does not re-dispatch running stages', () => {
      let plan = planRun('multi', ['linkedin', 'naukri']);
      plan = updateStageStatus(plan, 'linkedin', 'running');
      const d = nextDispatch(plan);
      expect(d.action).toBe('dispatch');
      if (d.action === 'dispatch') {
        expect(d.stages).toHaveLength(1);
        expect(d.stages[0]?.platformKey).toBe('naukri');
      }
    });
  });

  it('reports complete when all stages are terminal', () => {
    let plan = planRun('multi', ['linkedin', 'naukri']);
    plan = updateStageStatus(plan, 'linkedin', 'done');
    plan = updateStageStatus(plan, 'naukri', 'failed');
    expect(nextDispatch(plan).action).toBe('complete');
    expect(isRunComplete(plan)).toBe(true);
  });

  it('runOutcome aggregates stage results', () => {
    let p1 = planRun('multi', ['linkedin', 'naukri']);
    p1 = updateStageStatus(p1, 'linkedin', 'done');
    p1 = updateStageStatus(p1, 'naukri', 'done');
    expect(runOutcome(p1)).toBe('done');

    let p2 = planRun('multi', ['linkedin', 'naukri']);
    p2 = updateStageStatus(p2, 'linkedin', 'done');
    p2 = updateStageStatus(p2, 'naukri', 'failed');
    expect(runOutcome(p2)).toBe('partial');

    let p3 = planRun('single', ['linkedin']);
    p3 = updateStageStatus(p3, 'linkedin', 'failed');
    expect(runOutcome(p3)).toBe('failed');
  });

  it('updateStageStatus is immutable', () => {
    const plan = planRun('single', ['linkedin']);
    const updated = updateStageStatus(plan, 'linkedin', 'running');
    expect(plan.stages[0]?.status).toBe('pending');
    expect(updated.stages[0]?.status).toBe('running');
  });
});
