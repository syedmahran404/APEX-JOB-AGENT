// Cost governor — sits in front of every model call. Decides pass/downgrade/skip
// based on the user's daily spend vs ceiling, plus a per-user burst token bucket.
// Pure decision logic; the ATOMIC ledger debit is an injected effect so the
// race-free `UPDATE ... WHERE cost + ? <= ceiling RETURNING` (audit B1) lives in
// the db repository, while the policy is unit-testable here.
//
// Reference: docs/architecture/07-ai-engine.md §7; docs/audit B1.

import type { Tier } from '../providers/types.js';
import { downgradeTier } from '../registry/models.js';

export type GovernorAction = 'pass' | 'downgrade' | 'skip';

export interface GovernorState {
  /** USD spent today by the user. */
  spentTodayUsd: number;
  /** USD daily ceiling for the user. */
  dailyCeilingUsd: number;
}

export interface GovernorRequest {
  tier: Tier;
  /** Estimated USD cost of this call. */
  estimatedCostUsd: number;
  /** True for non-essential prompts (resume.tailor, cover.letter). */
  nonEssential: boolean;
}

export interface GovernorDecision {
  action: GovernorAction;
  /** The tier to actually use (may be downgraded). */
  effectiveTier: Tier;
  /** Why, for the ai_decisions.governor_action audit field. */
  reason: string;
}

/** Fraction of ceiling spent. */
function ratio(state: GovernorState): number {
  if (state.dailyCeilingUsd <= 0) return 1;
  return state.spentTodayUsd / state.dailyCeilingUsd;
}

/**
 * Decide what to do with a call given the user's budget pressure (§7.2):
 *  - < 80%: normal pass.
 *  - 80–95%: skip non-essential prompts; downgrade `reason` to a cheaper tier;
 *    no `reason` upgrades.
 *  - >= 95%: pause new AI work (skip).
 * A single call that would exceed the ceiling outright is skipped regardless.
 */
export function decide(state: GovernorState, req: GovernorRequest): GovernorDecision {
  // Hard ceiling: this call would push spend over the ceiling.
  if (state.spentTodayUsd + req.estimatedCostUsd > state.dailyCeilingUsd) {
    return { action: 'skip', effectiveTier: req.tier, reason: 'would-exceed-daily-ceiling' };
  }

  const r = ratio(state);
  if (r >= 0.95) {
    return { action: 'skip', effectiveTier: req.tier, reason: 'budget>=95%-paused' };
  }
  if (r >= 0.8) {
    if (req.nonEssential) {
      return { action: 'skip', effectiveTier: req.tier, reason: 'budget>=80%-skip-non-essential' };
    }
    if (req.tier === 'reason') {
      const downgraded = downgradeTier('reason') ?? 'default';
      return { action: 'downgrade', effectiveTier: downgraded, reason: 'budget>=80%-downgrade-reason' };
    }
    return { action: 'pass', effectiveTier: req.tier, reason: 'budget>=80%-pass-essential' };
  }
  return { action: 'pass', effectiveTier: req.tier, reason: 'normal' };
}

/**
 * The atomic-debit contract. ai-service's db repository implements this with a
 * single `UPDATE ai_cost_ledger SET spent = spent + $cost WHERE user_id = $u AND
 * spent + $cost <= ceiling RETURNING spent` (audit B1 — no read-modify-write race).
 */
export interface CostLedger {
  /** Attempt to debit atomically; returns false if it would breach the ceiling. */
  tryDebit(userId: string, costUsd: number): Promise<boolean>;
}

// ---- Burst control: token bucket (60/min, 600/hr per user) ----

export interface BurstLimits {
  perMinute: number;
  perHour: number;
}

export const DEFAULT_BURST: BurstLimits = { perMinute: 60, perHour: 600 };

/**
 * Two-window burst limiter. Deterministic (time injected). Both the minute and
 * hour windows must allow the call. Sliding-window via timestamp pruning.
 */
export class BurstLimiter {
  private readonly minuteHits: number[] = [];
  private readonly hourHits: number[] = [];

  constructor(private readonly limits: BurstLimits = DEFAULT_BURST) {}

  private prune(nowMs: number): void {
    const minuteAgo = nowMs - 60_000;
    const hourAgo = nowMs - 3_600_000;
    while (this.minuteHits.length > 0 && (this.minuteHits[0] ?? 0) < minuteAgo) this.minuteHits.shift();
    while (this.hourHits.length > 0 && (this.hourHits[0] ?? 0) < hourAgo) this.hourHits.shift();
  }

  /** True if a call is allowed at `nowMs` without recording it. */
  allowed(nowMs: number): boolean {
    this.prune(nowMs);
    return this.minuteHits.length < this.limits.perMinute && this.hourHits.length < this.limits.perHour;
  }

  /** Record a call if allowed; returns whether it was admitted. */
  tryAcquire(nowMs: number): boolean {
    if (!this.allowed(nowMs)) return false;
    this.minuteHits.push(nowMs);
    this.hourHits.push(nowMs);
    return true;
  }
}
