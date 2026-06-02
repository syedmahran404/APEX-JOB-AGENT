// Pacing profiles + rate accounting. Each adapter declares per-action-class
// timing bands; the worker honors them. A token bucket bounds sustained action
// rate to human-equivalent ceilings. Pure & deterministic (clock injected).
//
// Reference: docs/architecture/06-automation-engine.md §6.2, §6.3.

import type { AntiDetectionProfile } from '../contract.js';
import type { Rng } from './behavior.js';

/** Classes of action the engine paces. */
export type ActionClass = 'navigate' | 'click' | 'type' | 'scroll' | 'think';

/** min / median / max milliseconds for an action class. */
export interface PaceBand {
  min: number;
  median: number;
  max: number;
}

export type PaceProfile = Record<ActionClass, PaceBand>;

/** STRICT_DEFAULT — conservative, human-equivalent. The production default. */
export const STRICT_DEFAULT: PaceProfile = {
  navigate: { min: 1200, median: 2200, max: 4500 },
  click: { min: 250, median: 600, max: 1400 },
  type: { min: 40, median: 90, max: 220 },
  scroll: { min: 400, median: 900, max: 1800 },
  think: { min: 800, median: 2000, max: 6000 },
};

/** BALANCED — faster, still within plausible human ranges. */
export const BALANCED: PaceProfile = {
  navigate: { min: 800, median: 1400, max: 2800 },
  click: { min: 150, median: 380, max: 900 },
  type: { min: 25, median: 60, max: 150 },
  scroll: { min: 250, median: 600, max: 1200 },
  think: { min: 400, median: 1100, max: 3200 },
};

/** FAST — for offline fixture tests only; not for real sites. */
export const FAST: PaceProfile = {
  navigate: { min: 0, median: 5, max: 20 },
  click: { min: 0, median: 2, max: 10 },
  type: { min: 0, median: 1, max: 5 },
  scroll: { min: 0, median: 2, max: 10 },
  think: { min: 0, median: 2, max: 10 },
};

export function paceProfileFor(profile: AntiDetectionProfile): PaceProfile {
  switch (profile) {
    case 'STRICT_DEFAULT':
      return STRICT_DEFAULT;
    case 'BALANCED':
      return BALANCED;
    case 'FAST':
      return FAST;
  }
}

/**
 * Sample a delay for an action class using a triangular distribution over the
 * band (min, median, max). Deterministic given the RNG.
 */
export function sampleDelay(rng: Rng, band: PaceBand): number {
  const { min, median: mode, max } = band;
  if (max <= min) return min;
  const u = rng.next();
  const fc = (mode - min) / (max - min);
  let x: number;
  if (u < fc) {
    x = min + Math.sqrt(u * (max - min) * (mode - min));
  } else {
    x = max - Math.sqrt((1 - u) * (max - min) * (max - mode));
  }
  return Math.round(x);
}

/**
 * Token-bucket rate limiter for per-platform action accounting. Sustained rate
 * stays within `ratePerMin`; bursts up to `capacity`. Time is injected (ms) so
 * the bucket is fully deterministic and testable without timers.
 *
 * Default ceiling: ~30 actions/min/platform globally (§6.2).
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  readonly capacity: number;
  readonly refillPerMs: number;

  constructor(ratePerMin = 30, capacity = 30, nowMs = 0) {
    this.capacity = capacity;
    this.refillPerMs = ratePerMin / 60000;
    this.tokens = capacity;
    this.lastRefillMs = nowMs;
  }

  private refill(nowMs: number): void {
    if (nowMs <= this.lastRefillMs) return;
    const elapsed = nowMs - this.lastRefillMs;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefillMs = nowMs;
  }

  /** Try to take one token at time `nowMs`. Returns true if granted. */
  tryRemove(nowMs: number, cost = 1): boolean {
    this.refill(nowMs);
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }

  /** Milliseconds until `cost` tokens will be available (0 if available now). */
  waitMs(nowMs: number, cost = 1): number {
    this.refill(nowMs);
    if (this.tokens >= cost) return 0;
    const deficit = cost - this.tokens;
    return Math.ceil(deficit / this.refillPerMs);
  }

  /** Current token count (after refilling to `nowMs`). For tests/metrics. */
  available(nowMs: number): number {
    this.refill(nowMs);
    return this.tokens;
  }
}
