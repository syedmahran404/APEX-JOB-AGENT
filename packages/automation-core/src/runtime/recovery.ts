// State-recovery logic. On restart/crash/power-failure the orchestrator and
// worker must resume EXACTLY where they stopped without re-applying to jobs that
// already succeeded. This module is the pure decision core: given a persisted
// run-progress snapshot, compute what remains and which jobs must be skipped.
//
// Persistence itself (PG rows) is the orchestrator/db's job; this is browser-
// and DB-free and fully unit-testable.
//
// Reference: docs/architecture/04-backend-design.md §4 (durable run state),
//            06-automation-engine.md §14 (recovery).

import type { PlatformKey } from '../contract.js';

export type JobOutcome = 'completed' | 'failed' | 'skipped' | 'in_progress' | 'pending';

/** The durable, per-job progress record (mirrors an `applications` row subset). */
export interface JobProgress {
  jobExternalId: string;
  /** Canonical cross-platform key (for duplicate prevention across platforms). */
  canonicalKey: string;
  outcome: JobOutcome;
  /** The last apply-step reached, for forensics + resume-from-step. */
  lastStep?: string | undefined;
}

/** A persisted snapshot of a run's progress at the moment of interruption. */
export interface RunProgressSnapshot {
  runId: string;
  userId: string;
  /** The platform stage that was active when interrupted, if any. */
  currentPlatform?: PlatformKey | undefined;
  /** The job that was mid-application when interrupted, if any. */
  currentJobExternalId?: string | undefined;
  jobs: JobProgress[];
}

export interface ResumePlan {
  /** Jobs to (re)dispatch — pending + the interrupted in-progress job. */
  toDispatch: JobProgress[];
  /** Jobs already terminal — never re-dispatch (duplicate prevention). */
  alreadyTerminal: JobProgress[];
  /** External ids already applied/terminal — the worker's skip set. */
  skipExternalIds: Set<string>;
  /** Canonical keys already applied — cross-platform duplicate guard. */
  skipCanonicalKeys: Set<string>;
}

/**
 * Compute the resume plan from a progress snapshot.
 *
 * Resumption rules:
 *  - `completed`/`failed`/`skipped` are terminal → never re-dispatched.
 *  - `in_progress` jobs are re-dispatched (the worker resumes from lastStep, and
 *    the idempotency key prevents a duplicate submit if it actually completed).
 *  - `pending` jobs are dispatched normally.
 *  - The skip sets (external id + canonical key) prevent duplicate applications,
 *    including the same role discovered on another platform.
 */
export function planResume(snapshot: RunProgressSnapshot): ResumePlan {
  const toDispatch: JobProgress[] = [];
  const alreadyTerminal: JobProgress[] = [];
  const skipExternalIds = new Set<string>();
  const skipCanonicalKeys = new Set<string>();

  for (const job of snapshot.jobs) {
    if (job.outcome === 'completed' || job.outcome === 'failed' || job.outcome === 'skipped') {
      alreadyTerminal.push(job);
      skipExternalIds.add(job.jobExternalId);
      // Only a completed application blocks the canonical key (a failed/skipped
      // attempt on one platform should not block a fresh attempt elsewhere).
      if (job.outcome === 'completed') skipCanonicalKeys.add(job.canonicalKey);
    } else {
      // pending or in_progress → (re)dispatch.
      toDispatch.push(job);
    }
  }
  return { toDispatch, alreadyTerminal, skipExternalIds, skipCanonicalKeys };
}

/**
 * Decide whether a job may be applied to, given the run's accumulated skip sets.
 * Used by the worker just before opening an application as a final guard against
 * duplicates (defense in depth alongside the DB partial-unique index).
 */
export function mayApply(
  job: { jobExternalId: string; canonicalKey: string },
  resume: Pick<ResumePlan, 'skipExternalIds' | 'skipCanonicalKeys'>,
): { allowed: boolean; reason?: 'external_id_applied' | 'canonical_applied' } {
  if (resume.skipExternalIds.has(job.jobExternalId)) {
    return { allowed: false, reason: 'external_id_applied' };
  }
  if (resume.skipCanonicalKeys.has(job.canonicalKey)) {
    return { allowed: false, reason: 'canonical_applied' };
  }
  return { allowed: true };
}

/** Summarize counts for run-completion reporting and dashboards. */
export function summarizeProgress(snapshot: RunProgressSnapshot): Record<JobOutcome, number> {
  const counts: Record<JobOutcome, number> = {
    completed: 0,
    failed: 0,
    skipped: 0,
    in_progress: 0,
    pending: 0,
  };
  for (const job of snapshot.jobs) counts[job.outcome]++;
  return counts;
}
