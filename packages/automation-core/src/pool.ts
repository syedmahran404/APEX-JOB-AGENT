// BrowserPool interface + concurrency policy.
//
// The concrete pool (Playwright Browser/BrowserContext lifecycle) lives in
// apps/automation-worker, which implements this interface. Here we define the
// contract and the PURE concurrency policy:
//   - one active page per (user, platform),
//   - N parallel (user, platform) pairs per worker,
//   - never two tasks for the same user simultaneously, even across platforms.
//
// Reference: docs/architecture/06-automation-engine.md §5.

import type { PlatformKey } from './contract.js';
import { PreconditionFailedError } from '@apex/shared-errors';

/** Default parallel (user,platform) pairs per worker pod (tuned by memory). */
export const DEFAULT_MAX_PAIRS = 4;
/** Safe memory headroom per active context (bytes); 1 GiB. */
export const CONTEXT_MEMORY_BUDGET_BYTES = 1024 * 1024 * 1024;

export interface LeasedContext {
  readonly userId: string;
  readonly platformKey: PlatformKey;
  /** Opaque Playwright BrowserContext. */
  readonly browserContext: unknown;
}

/** The lifecycle contract the worker implements. */
export interface BrowserPool {
  /** Acquire (reuse warm / restore / cold-create) a context for (user, platform). */
  acquire(userId: string, platform: PlatformKey): Promise<LeasedContext>;
  /** Persist storage state and reset TTL; keeps the context warm. */
  release(lease: LeasedContext): Promise<void>;
  /** Save-and-close idle contexts past TTL. Returns count evicted. */
  evictIdle(nowMs: number): Promise<number>;
  /** Current active/idle counts for metrics. */
  stats(): { active: number; idle: number };
  /** Graceful teardown. */
  shutdown(): Promise<void>;
}

/** Concurrency key for a (user, platform) pair. */
export function pairKey(userId: string, platform: PlatformKey): string {
  return `${userId}:${platform}`;
}

/**
 * Pure admission controller for worker concurrency. Tracks which users and
 * (user,platform) pairs are active and enforces the three rules. The worker
 * pairs this with a Redis semaphore for cross-process enforcement; this class
 * is the in-process policy and is fully unit-testable.
 */
export class ConcurrencyGuard {
  private readonly activeUsers = new Set<string>();
  private readonly activePairs = new Set<string>();
  readonly maxPairs: number;

  constructor(maxPairs: number = DEFAULT_MAX_PAIRS) {
    this.maxPairs = maxPairs;
  }

  /** Reason a task cannot be admitted, or null when admissible. */
  rejectionReason(userId: string, platform: PlatformKey): string | null {
    if (this.activeUsers.has(userId)) {
      return 'user-already-active'; // never two tasks for the same user at once
    }
    const key = pairKey(userId, platform);
    if (this.activePairs.has(key)) {
      return 'pair-already-active'; // one active page per (user, platform)
    }
    if (this.activePairs.size >= this.maxPairs) {
      return 'worker-at-capacity';
    }
    return null;
  }

  canAdmit(userId: string, platform: PlatformKey): boolean {
    return this.rejectionReason(userId, platform) === null;
  }

  /** Admit a task; throws if it would violate a rule (call canAdmit first). */
  admit(userId: string, platform: PlatformKey): void {
    const reason = this.rejectionReason(userId, platform);
    if (reason !== null) {
      throw new PreconditionFailedError(`Cannot admit task for ${userId}/${platform}: ${reason}`, {
        reason,
        userId,
        platform,
      });
    }
    this.activeUsers.add(userId);
    this.activePairs.add(pairKey(userId, platform));
  }

  /** Release a task's slots. */
  release(userId: string, platform: PlatformKey): void {
    this.activeUsers.delete(userId);
    this.activePairs.delete(pairKey(userId, platform));
  }

  stats(): { activeUsers: number; activePairs: number; maxPairs: number } {
    return { activeUsers: this.activeUsers.size, activePairs: this.activePairs.size, maxPairs: this.maxPairs };
  }
}
