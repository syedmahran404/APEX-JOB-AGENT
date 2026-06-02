// Pure run-planning + dispatch logic. The orchestrator owns the side effects
// (DB writes, queue puts); this module owns the DECISIONS, so they are fully
// unit-testable with no DB or Redis.
//
// A run targets one or more platforms. Each platform becomes a "stage". Stages
// run in a deterministic order (the canonical platform sequence). Within a run
// we enforce sequential-per-(user, platform); across platforms a run advances
// one stage at a time in single-platform mode, or fans out in multi-platform
// mode while still respecting the per-user concurrency rule at the worker.
//
// Reference: docs/architecture/01-system-architecture.md, 04-backend-design.md §4.

import type { PlatformKey } from '../contract.js';

export type RunMode = 'single' | 'multi';

/** Canonical platform ordering for deterministic stage sequencing. */
export const CANONICAL_PLATFORM_ORDER: PlatformKey[] = [
  'linkedin',
  'naukri',
  'indeed',
  'internshala',
  'glassdoor',
  'foundit',
  'wellfound',
  'upwork',
];

export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface PlannedStage {
  platformKey: PlatformKey;
  ordinal: number;
  status: StageStatus;
}

export interface RunPlan {
  mode: RunMode;
  stages: PlannedStage[];
}

/**
 * Build the ordered stage list for a run from the selected platforms. Order is
 * the canonical sequence intersected with the selection (stable, deterministic).
 * Unknown platform keys are dropped (the caller validates membership upstream).
 */
export function planRun(mode: RunMode, platforms: PlatformKey[]): RunPlan {
  const selected = new Set(platforms);
  const stages: PlannedStage[] = CANONICAL_PLATFORM_ORDER.filter((p) => selected.has(p)).map((platformKey, i) => ({
    platformKey,
    ordinal: i,
    status: 'pending',
  }));
  return { mode, stages };
}

export type DispatchDecision =
  | { action: 'dispatch'; stages: PlannedStage[] }
  | { action: 'complete' } // all stages terminal
  | { action: 'wait' }; // stages in flight, nothing new to dispatch

/**
 * Decide which stage(s) to dispatch next given the current stage statuses.
 *
 * - single mode: dispatch at most ONE pending stage, and only when no stage is
 *   currently running (strict sequential).
 * - multi mode: dispatch ALL pending stages that are not yet running (the
 *   per-user concurrency rule is enforced at the worker, not here).
 *
 * Returns `complete` when every stage is terminal (done/failed/skipped), and
 * `wait` when stages are running but none are dispatchable right now.
 */
export function nextDispatch(plan: RunPlan): DispatchDecision {
  const isTerminal = (s: StageStatus): boolean => s === 'done' || s === 'failed' || s === 'skipped';
  if (plan.stages.every((s) => isTerminal(s.status))) {
    return { action: 'complete' };
  }
  const running = plan.stages.filter((s) => s.status === 'running');
  const pending = plan.stages.filter((s) => s.status === 'pending');

  if (plan.mode === 'single') {
    if (running.length > 0) return { action: 'wait' };
    const next = pending[0];
    return next ? { action: 'dispatch', stages: [next] } : { action: 'wait' };
  }

  // multi
  if (pending.length === 0) return { action: 'wait' };
  return { action: 'dispatch', stages: pending };
}

/** Apply a stage status update immutably, returning a new plan. */
export function updateStageStatus(plan: RunPlan, platformKey: PlatformKey, status: StageStatus): RunPlan {
  return {
    mode: plan.mode,
    stages: plan.stages.map((s) => (s.platformKey === platformKey ? { ...s, status } : s)),
  };
}

/** True when every stage reached a terminal status. */
export function isRunComplete(plan: RunPlan): boolean {
  return plan.stages.every((s) => s.status === 'done' || s.status === 'failed' || s.status === 'skipped');
}

/** Aggregate the run's terminal outcome from its stages. */
export function runOutcome(plan: RunPlan): 'done' | 'failed' | 'partial' {
  const anyDone = plan.stages.some((s) => s.status === 'done');
  const anyFailed = plan.stages.some((s) => s.status === 'failed');
  if (anyFailed && anyDone) return 'partial';
  if (anyFailed && !anyDone) return 'failed';
  return 'done';
}
