// RecoveryManager — retry-with-backoff helper + per-platform circuit breaker.
//
// The breaker is in-process; multi-replica synchronization is via Redis in a
// later phase (when the worker fleet exceeds 1 replica per platform). For
// Phase 2's single-worker target, in-memory state is sufficient and matches
// the audit's "operate at scale" guidance with a clear extension point.

import type { Logger } from '@apex/shared-logger';
import { CancellationError } from '../types/errors.js';
import type { RecoveryManager, RetryPolicy } from './interfaces.js';
import { sleep } from '../utils/delay.js';
import type { PlatformKey } from '../types/adapter.js';

export interface DefaultRecoveryManagerOptions {
  logger: Logger;
  defaultPolicy?: Partial<RetryPolicy>;
}

interface BreakerEntry {
  until: number;
  reason: string;
}

export class DefaultRecoveryManager implements RecoveryManager {
  private readonly logger: Logger;
  private readonly defaultPolicy: RetryPolicy;
  private readonly breakers = new Map<PlatformKey, BreakerEntry>();

  constructor(opts: DefaultRecoveryManagerOptions) {
    this.logger = opts.logger.child({ component: 'recovery-manager' });
    this.defaultPolicy = {
      maxAttempts: opts.defaultPolicy?.maxAttempts ?? 3,
      baseDelayMs: opts.defaultPolicy?.baseDelayMs ?? 500,
      maxDelayMs: opts.defaultPolicy?.maxDelayMs ?? 30_000,
      isRetryable: opts.defaultPolicy?.isRetryable ?? defaultIsRetryable,
    };
  }

  async withRetry<T>(name: string, fn: () => Promise<T>, override?: Partial<RetryPolicy>): Promise<T> {
    const policy: RetryPolicy = {
      maxAttempts: override?.maxAttempts ?? this.defaultPolicy.maxAttempts,
      baseDelayMs: override?.baseDelayMs ?? this.defaultPolicy.baseDelayMs,
      maxDelayMs: override?.maxDelayMs ?? this.defaultPolicy.maxDelayMs,
      isRetryable: override?.isRetryable ?? this.defaultPolicy.isRetryable,
    };
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (err instanceof CancellationError) throw err;
        if (!policy.isRetryable(err) || attempt === policy.maxAttempts) {
          this.logger.warn(
            { name, attempt, max: policy.maxAttempts, err: (err as Error).message },
            'retry exhausted or non-retryable',
          );
          throw err;
        }
        const delay = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
        const jitter = Math.floor(Math.random() * (policy.baseDelayMs / 2));
        this.logger.debug({ name, attempt, delay: delay + jitter }, 'retrying after backoff');
        await sleep(delay + jitter);
      }
    }
    throw lastErr;
  }

  trip(platformKey: PlatformKey, cooldownMs: number, reason: string): void {
    const until = Date.now() + cooldownMs;
    this.breakers.set(platformKey, { until, reason });
    this.logger.warn({ platformKey, until: new Date(until), reason }, 'circuit tripped');
  }

  isTripped(platformKey: PlatformKey): boolean {
    const entry = this.breakers.get(platformKey);
    if (!entry) return false;
    if (entry.until < Date.now()) {
      this.breakers.delete(platformKey);
      return false;
    }
    return true;
  }

  trippedPlatforms(): ReadonlyArray<{ platformKey: PlatformKey; until: Date; reason: string }> {
    const out: Array<{ platformKey: PlatformKey; until: Date; reason: string }> = [];
    for (const [key, e] of this.breakers.entries()) {
      if (e.until < Date.now()) continue;
      out.push({ platformKey: key, until: new Date(e.until), reason: e.reason });
    }
    return out;
  }
}

function defaultIsRetryable(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: string }).code;
  if (
    code === 'unauthenticated' ||
    code === 'forbidden' ||
    code === 'precondition_failed' ||
    code === 'not_found'
  ) {
    return false;
  }
  return true;
}
