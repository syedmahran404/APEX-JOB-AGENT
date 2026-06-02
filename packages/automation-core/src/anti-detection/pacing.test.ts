import { describe, it, expect } from 'vitest';
import { makeRng } from './behavior.js';
import {
  STRICT_DEFAULT,
  BALANCED,
  FAST,
  paceProfileFor,
  sampleDelay,
  TokenBucket,
} from './pacing.js';

describe('anti-detection/pacing', () => {
  it('paceProfileFor returns the right profile; FAST is near-instant', () => {
    expect(paceProfileFor('STRICT_DEFAULT')).toBe(STRICT_DEFAULT);
    expect(paceProfileFor('BALANCED')).toBe(BALANCED);
    expect(paceProfileFor('FAST')).toBe(FAST);
    expect(FAST.navigate.max).toBeLessThanOrEqual(20);
  });

  it('sampleDelay stays within the band [min, max]', () => {
    const rng = makeRng(11);
    for (let i = 0; i < 200; i++) {
      const d = sampleDelay(rng, STRICT_DEFAULT.click);
      expect(d).toBeGreaterThanOrEqual(STRICT_DEFAULT.click.min);
      expect(d).toBeLessThanOrEqual(STRICT_DEFAULT.click.max);
    }
  });

  it('STRICT_DEFAULT is slower (more conservative) than BALANCED at the median', () => {
    expect(STRICT_DEFAULT.navigate.median).toBeGreaterThan(BALANCED.navigate.median);
  });

  describe('TokenBucket', () => {
    it('grants up to capacity immediately, then throttles', () => {
      const tb = new TokenBucket(30, 5, 0);
      for (let i = 0; i < 5; i++) expect(tb.tryRemove(0)).toBe(true);
      expect(tb.tryRemove(0)).toBe(false); // bucket empty
    });

    it('refills over time at the configured rate', () => {
      // 60/min = 1 token per 1000ms.
      const tb = new TokenBucket(60, 5, 0);
      for (let i = 0; i < 5; i++) tb.tryRemove(0);
      expect(tb.tryRemove(0)).toBe(false);
      // After 1000ms exactly one token returns.
      expect(tb.tryRemove(1000)).toBe(true);
      expect(tb.tryRemove(1000)).toBe(false);
    });

    it('waitMs reports time until the next token', () => {
      const tb = new TokenBucket(60, 1, 0);
      expect(tb.tryRemove(0)).toBe(true);
      // Empty now; next token in ~1000ms.
      expect(tb.waitMs(0)).toBeGreaterThan(0);
      expect(tb.waitMs(0)).toBeLessThanOrEqual(1000);
    });

    it('never exceeds capacity when idle a long time', () => {
      const tb = new TokenBucket(30, 30, 0);
      expect(tb.available(10_000_000)).toBeLessThanOrEqual(30);
    });
  });
});
