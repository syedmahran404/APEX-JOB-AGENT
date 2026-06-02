// Behavior layer — how the page is touched. Pure math: mouse path geometry,
// keystroke timing, scroll pauses. All functions take an explicit RNG so they
// are deterministic and unit-testable; no browser, no global Math.random.
//
// Reference: docs/architecture/06-automation-engine.md §6.3.

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
}

/** A small, seedable PRNG (mulberry32) for deterministic behavior simulation. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next(): number {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

export interface Point {
  x: number;
  y: number;
}

/** Uniform sample in [min, max). */
function uniform(rng: Rng, min: number, max: number): number {
  return min + rng.next() * (max - min);
}

/**
 * Jitter a click point within the target's bounding box (never always center).
 * Stays within a central safe region (20%–80%) so clicks never miss the element.
 */
export function jitterClickPoint(
  rng: Rng,
  box: { x: number; y: number; width: number; height: number },
): Point {
  return {
    x: box.x + uniform(rng, 0.2, 0.8) * box.width,
    y: box.y + uniform(rng, 0.2, 0.8) * box.height,
  };
}

/**
 * Generate a Bezier-curved mouse path from `from` to `to` with slight overshoot.
 * Returns `steps`+1 points (inclusive of both ends). Quadratic Bezier with a
 * control point offset perpendicular to the travel direction.
 */
export function bezierMousePath(rng: Rng, from: Point, to: Point, steps = 24): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  // Perpendicular unit vector.
  const px = -dy / dist;
  const py = dx / dist;
  // Control point bulges off the straight line by up to ~15% of distance.
  const bulge = uniform(rng, -0.15, 0.15) * dist;
  const midX = (from.x + to.x) / 2 + px * bulge;
  const midY = (from.y + to.y) / 2 + py * bulge;

  const path: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    // Quadratic Bezier B(t) = (1-t)^2 P0 + 2(1-t)t C + t^2 P1.
    const x = mt * mt * from.x + 2 * mt * t * midX + t * t * to.x;
    const y = mt * mt * from.y + 2 * mt * t * midY + t * t * to.y;
    path.push({ x, y });
  }
  return path;
}

const QWERTY_ROWS = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'] as const;

/** Approximate key position on a QWERTY board for adjacency-aware timing. */
function keyPos(ch: string): { row: number; col: number } | null {
  const lower = ch.toLowerCase();
  for (let r = 0; r < QWERTY_ROWS.length; r++) {
    const col = QWERTY_ROWS[r]!.indexOf(lower);
    if (col >= 0) return { row: r, col };
  }
  return null;
}

/** Manhattan-ish keyboard distance between two characters (0 when unknown). */
export function keyDistance(a: string, b: string): number {
  const pa = keyPos(a);
  const pb = keyPos(b);
  if (!pa || !pb) return 2; // unknown chars (space, punctuation) → medium jump
  return Math.abs(pa.row - pb.row) + Math.abs(pa.col - pb.col);
}

/**
 * Per-character delays (ms) for typing `text`. Adjacent keys are faster; long
 * jumps are slower. We deliberately do NOT simulate typos/corrections (they hurt
 * accuracy and aren't worth it — §6.3). Delays are bounded to a human band.
 */
export function keystrokeDelays(rng: Rng, text: string): number[] {
  const delays: number[] = [];
  let prev: string | null = null;
  for (const ch of text) {
    let base: number;
    if (prev === null) {
      base = 120; // first keystroke
    } else {
      const d = keyDistance(prev, ch);
      base = 60 + d * 22; // adjacency-conditioned base
    }
    // ±35% human jitter.
    const jittered = base * uniform(rng, 0.65, 1.35);
    delays.push(clamp(Math.round(jittered), 40, 400));
    prev = ch;
  }
  return delays;
}

export interface ScrollPause {
  /** How far to scroll this segment, in viewport heights. */
  viewportFraction: number;
  /** Pause after this segment, in ms. */
  pauseMs: number;
}

/**
 * Plan an animated scroll over `totalViewports` viewport-heights, pausing every
 * 1–3 viewports for ~200–600 ms (§6.3).
 */
export function planScroll(rng: Rng, totalViewports: number): ScrollPause[] {
  const segments: ScrollPause[] = [];
  let remaining = totalViewports;
  while (remaining > 0) {
    const seg = Math.min(remaining, uniform(rng, 1, 3));
    segments.push({
      viewportFraction: Number(seg.toFixed(3)),
      pauseMs: Math.round(uniform(rng, 200, 600)),
    });
    remaining -= seg;
  }
  return segments;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
