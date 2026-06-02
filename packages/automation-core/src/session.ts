// Session & storage-state lifecycle policy. Pure decision logic for:
//  - the per-(user,platform) storage-state key (S3 object path),
//  - whether a warm context is still valid (TTL),
//  - whether a context needs a periodic refresh (7-day cap),
//  - whether a session must be re-established.
// The actual S3/Playwright I/O is performed by the worker; this is the policy.
//
// Reference: docs/architecture/06-automation-engine.md §5, §18.

import type { PlatformKey } from './contract.js';

/** Idle TTL for a warm context (10 minutes). */
export const CONTEXT_IDLE_TTL_MS = 10 * 60 * 1000;
/** Hard refresh cap for a context (7 days) regardless of activity. */
export const CONTEXT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Deterministic S3 object key for a user's platform storage-state. Stored
 * encrypted with the per-user data key; the key path itself carries no secret.
 */
export function storageStateKey(userId: string, platform: PlatformKey): string {
  return `storage-state/${userId}/${platform}.json.enc`;
}

export interface ContextMeta {
  /** When the context was created (cold start or restore). */
  createdAtMs: number;
  /** Last time a task used this context. */
  lastUsedAtMs: number;
  /** Current session status as last observed. */
  sessionStatus: 'authenticated' | 'expired' | 'blocked' | 'unknown';
}

export type ContextDecision =
  | { action: 'reuse' }
  | { action: 'refresh'; reason: 'idle-ttl' | 'max-age' }
  | { action: 're-auth'; reason: 'expired' | 'blocked' | 'unknown' };

/**
 * Decide what to do with a warm context at time `nowMs`:
 *  - blocked/expired/unknown session → re-authenticate.
 *  - older than the 7-day cap → refresh (save & recreate).
 *  - idle longer than TTL → refresh.
 *  - otherwise reuse.
 */
export function decideContext(meta: ContextMeta, nowMs: number): ContextDecision {
  if (meta.sessionStatus === 'blocked') return { action: 're-auth', reason: 'blocked' };
  if (meta.sessionStatus === 'expired') return { action: 're-auth', reason: 'expired' };
  if (meta.sessionStatus === 'unknown') return { action: 're-auth', reason: 'unknown' };

  if (nowMs - meta.createdAtMs >= CONTEXT_MAX_AGE_MS) {
    return { action: 'refresh', reason: 'max-age' };
  }
  if (nowMs - meta.lastUsedAtMs >= CONTEXT_IDLE_TTL_MS) {
    return { action: 'refresh', reason: 'idle-ttl' };
  }
  return { action: 'reuse' };
}

/** True when an idle context should be evicted (saved & closed) at `nowMs`. */
export function shouldEvict(meta: ContextMeta, nowMs: number): boolean {
  return nowMs - meta.lastUsedAtMs >= CONTEXT_IDLE_TTL_MS;
}
