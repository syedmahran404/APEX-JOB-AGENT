// Score calibration. The AI returns a 0–100 relevance score; we periodically
// join those with downstream outcomes (shortlisted/interview/offer) and fit a
// monotonic mapping so a score of 80 means roughly the same thing over time.
// A simple isotonic (pool-adjacent-violators) regressor — pure, deterministic.
//
// Reference: docs/architecture/07-ai-engine.md §14, §17.

export interface CalibrationPoint {
  /** Raw model score in [0, 100]. */
  rawScore: number;
  /** Observed positive-outcome rate in [0, 1] for this score bucket. */
  outcomeRate: number;
  /** Sample weight (e.g. number of applications in the bucket). */
  weight: number;
}

export interface CalibrationStep {
  /** Raw score at or above which this calibrated value applies. */
  threshold: number;
  /** Calibrated value in [0, 1]. */
  value: number;
}

/**
 * Fit an isotonic (non-decreasing) calibration curve from observed points using
 * the Pool Adjacent Violators Algorithm (PAVA). Returns a step function over the
 * sorted raw scores. Deterministic; ties broken by input order.
 */
export function fitIsotonic(points: CalibrationPoint[]): CalibrationStep[] {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => a.rawScore - b.rawScore);

  // Each block: weighted mean value + total weight + the min threshold.
  interface Block {
    value: number;
    weight: number;
    threshold: number;
  }
  const blocks: Block[] = [];
  for (const p of sorted) {
    let block: Block = { value: p.outcomeRate, weight: Math.max(p.weight, 1e-9), threshold: p.rawScore };
    // Merge while the previous block violates monotonicity.
    while (blocks.length > 0 && (blocks[blocks.length - 1]?.value ?? 0) > block.value) {
      const prev = blocks.pop()!;
      const totalW = prev.weight + block.weight;
      block = {
        value: (prev.value * prev.weight + block.value * block.weight) / totalW,
        weight: totalW,
        threshold: prev.threshold,
      };
    }
    blocks.push(block);
  }
  return blocks.map((b) => ({ threshold: b.threshold, value: Number(b.value.toFixed(6)) }));
}

/**
 * Apply a fitted calibration curve to a raw score → calibrated probability [0,1].
 * Uses the value of the highest threshold ≤ rawScore (step function).
 */
export function applyCalibration(curve: CalibrationStep[], rawScore: number): number {
  if (curve.length === 0) return rawScore / 100;
  let value = curve[0]?.value ?? rawScore / 100;
  for (const step of curve) {
    if (rawScore >= step.threshold) value = step.value;
    else break;
  }
  return value;
}

/**
 * Decide whether a job clears the apply threshold given its calibrated score and
 * the user's minimum. Returns a structured reason for the skip audit.
 */
export function applyDecision(
  rawScore: number,
  curve: CalibrationStep[],
  minCalibrated: number,
): { apply: boolean; calibrated: number; reason: string } {
  const calibrated = applyCalibration(curve, rawScore);
  if (calibrated >= minCalibrated) return { apply: true, calibrated, reason: 'above-threshold' };
  return { apply: false, calibrated, reason: 'below-threshold' };
}
