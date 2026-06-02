import { describe, it, expect } from 'vitest';
import { decide, BurstLimiter, DEFAULT_BURST, type GovernorState } from './cost.js';

const ceiling = (spent: number): GovernorState => ({ spentTodayUsd: spent, dailyCeilingUsd: 0.5 });

describe('governor/cost decide (§7.2)', () => {
  it('passes under 80% budget', () => {
    const d = decide(ceiling(0.1), { tier: 'reason', estimatedCostUsd: 0.01, nonEssential: false });
    expect(d.action).toBe('pass');
    expect(d.effectiveTier).toBe('reason');
  });

  it('skips a call that would exceed the daily ceiling outright', () => {
    const d = decide(ceiling(0.49), { tier: 'default', estimatedCostUsd: 0.05, nonEssential: false });
    expect(d.action).toBe('skip');
    expect(d.reason).toMatch(/exceed/);
  });

  it('at 80–95%: skips non-essential prompts', () => {
    const d = decide(ceiling(0.42), { tier: 'default', estimatedCostUsd: 0.001, nonEssential: true });
    expect(d.action).toBe('skip');
    expect(d.reason).toMatch(/non-essential/);
  });

  it('at 80–95%: downgrades reason → default for essential prompts', () => {
    const d = decide(ceiling(0.42), { tier: 'reason', estimatedCostUsd: 0.001, nonEssential: false });
    expect(d.action).toBe('downgrade');
    expect(d.effectiveTier).toBe('default');
  });

  it('at 80–95%: passes essential non-reason prompts unchanged', () => {
    const d = decide(ceiling(0.42), { tier: 'default', estimatedCostUsd: 0.001, nonEssential: false });
    expect(d.action).toBe('pass');
  });

  it('at >=95%: pauses all new AI work', () => {
    const d = decide(ceiling(0.48), { tier: 'fast', estimatedCostUsd: 0.0001, nonEssential: false });
    expect(d.action).toBe('skip');
    expect(d.reason).toMatch(/95%/);
  });
});

describe('governor/cost BurstLimiter', () => {
  it('allows up to perMinute then throttles within the minute', () => {
    const limiter = new BurstLimiter({ perMinute: 3, perHour: 100 });
    expect(limiter.tryAcquire(1000)).toBe(true);
    expect(limiter.tryAcquire(1001)).toBe(true);
    expect(limiter.tryAcquire(1002)).toBe(true);
    expect(limiter.tryAcquire(1003)).toBe(false); // minute window full
  });

  it('refills as the minute window slides', () => {
    const limiter = new BurstLimiter({ perMinute: 1, perHour: 100 });
    expect(limiter.tryAcquire(0)).toBe(true);
    expect(limiter.tryAcquire(100)).toBe(false);
    expect(limiter.tryAcquire(60_001)).toBe(true); // first hit aged out
  });

  it('enforces the hourly cap independently', () => {
    const limiter = new BurstLimiter({ perMinute: 100, perHour: 2 });
    expect(limiter.tryAcquire(0)).toBe(true);
    expect(limiter.tryAcquire(1)).toBe(true);
    expect(limiter.tryAcquire(2)).toBe(false); // hour window full
  });

  it('default burst is 60/min, 600/hr', () => {
    expect(DEFAULT_BURST).toEqual({ perMinute: 60, perHour: 600 });
  });
});
