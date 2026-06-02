import { describe, it, expect } from 'vitest';
import { fitIsotonic, applyCalibration, applyDecision } from './isotonic.js';

describe('calibration/isotonic', () => {
  it('fits a non-decreasing curve (PAVA pools violators)', () => {
    const curve = fitIsotonic([
      { rawScore: 10, outcomeRate: 0.1, weight: 1 },
      { rawScore: 20, outcomeRate: 0.05, weight: 1 }, // violation → pooled with prev
      { rawScore: 30, outcomeRate: 0.4, weight: 1 },
      { rawScore: 40, outcomeRate: 0.6, weight: 1 },
    ]);
    // Resulting values must be non-decreasing.
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]!.value).toBeGreaterThanOrEqual(curve[i - 1]!.value);
    }
  });

  it('applyCalibration is monotonic in rawScore', () => {
    const curve = fitIsotonic([
      { rawScore: 10, outcomeRate: 0.1, weight: 1 },
      { rawScore: 50, outcomeRate: 0.5, weight: 1 },
      { rawScore: 90, outcomeRate: 0.9, weight: 1 },
    ]);
    expect(applyCalibration(curve, 90)).toBeGreaterThanOrEqual(applyCalibration(curve, 50));
    expect(applyCalibration(curve, 50)).toBeGreaterThanOrEqual(applyCalibration(curve, 10));
  });

  it('falls back to rawScore/100 with an empty curve', () => {
    expect(applyCalibration([], 80)).toBeCloseTo(0.8, 5);
  });

  it('applyDecision gates on the calibrated threshold', () => {
    const curve = fitIsotonic([
      { rawScore: 50, outcomeRate: 0.3, weight: 1 },
      { rawScore: 80, outcomeRate: 0.7, weight: 1 },
    ]);
    const high = applyDecision(80, curve, 0.5);
    expect(high.apply).toBe(true);
    const low = applyDecision(50, curve, 0.5);
    expect(low.apply).toBe(false);
    expect(low.reason).toBe('below-threshold');
  });
});
