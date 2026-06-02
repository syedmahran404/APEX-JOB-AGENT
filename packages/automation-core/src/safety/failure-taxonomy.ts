// Failure taxonomy and recovery policy. Classifies an error/condition into a
// recovery class and prescribes the recovery action. Pure & deterministic.
//
// Reference: docs/architecture/06-automation-engine.md §14.

export type FailureClass =
  | 'transient.network'
  | 'transient.platform'
  | 'transient.element'
  | 'permanent.selector_drift'
  | 'permanent.policy'
  | 'permanent.account'
  | 'permanent.captcha'
  | 'unknown';

export type RecoveryAction =
  | { kind: 'retry'; maxAttempts: number; backoff: 'exponential' | 'fixed' }
  | { kind: 'retry-once' }
  | { kind: 'tier-platform'; minutes: number }
  | { kind: 'park-adapter' }
  | { kind: 'skip'; reason: string }
  | { kind: 'halt-platform'; reason: string }
  | { kind: 'pause-or-skip' } // mode A pause, mode B skip
  | { kind: 'capture-and-alert' };

export interface ClassifiedFailure {
  class: FailureClass;
  recoverable: boolean;
  action: RecoveryAction;
}

/** A normalized error signal for classification (browser-free). */
export interface FailureSignal {
  /** Lowercased error message or condition string. */
  message: string;
  /** HTTP status if the failure was an HTTP response. */
  httpStatus?: number | undefined;
  /** True when a selector strategy chain exhausted without resolving. */
  selectorExhausted?: boolean | undefined;
  /** Set when a challenge persisted across attempts. */
  captchaPersistent?: boolean | undefined;
}

export function classifyFailure(signal: FailureSignal): ClassifiedFailure {
  const msg = signal.message.toLowerCase();

  // permanent.account — login refused, flagged, 2FA loop.
  if (/account (is )?(flagged|restricted|suspended|blocked)/.test(msg) || /login refused/.test(msg) || /2fa loop/.test(msg)) {
    return { class: 'permanent.account', recoverable: false, action: { kind: 'halt-platform', reason: 'account' } };
  }

  // permanent.captcha — persistent challenge.
  if (signal.captchaPersistent === true || /persistent (captcha|challenge)/.test(msg)) {
    return { class: 'permanent.captcha', recoverable: false, action: { kind: 'pause-or-skip' } };
  }

  // permanent.selector_drift — selector chain exhausted.
  if (signal.selectorExhausted === true || /selector .*(missing|not found|exhausted)/.test(msg)) {
    return { class: 'permanent.selector_drift', recoverable: false, action: { kind: 'park-adapter' } };
  }

  // permanent.policy — low-confidence answer, banned content, missing required field.
  if (/low.?confidence/.test(msg) || /banned content/.test(msg) || /required field/.test(msg)) {
    return { class: 'permanent.policy', recoverable: false, action: { kind: 'skip', reason: 'policy' } };
  }

  // transient.platform — 429 or platform "experiencing issues".
  if (signal.httpStatus === 429 || /experiencing issues|temporarily unavailable|try again later/.test(msg)) {
    return { class: 'transient.platform', recoverable: true, action: { kind: 'tier-platform', minutes: 15 } };
  }

  // transient.network — DNS / reset / 5xx.
  if (
    (signal.httpStatus !== undefined && signal.httpStatus >= 500 && signal.httpStatus < 600) ||
    /\b(econnreset|etimedout|enotfound|dns|socket hang up|network)\b/.test(msg)
  ) {
    return { class: 'transient.network', recoverable: true, action: { kind: 'retry', maxAttempts: 3, backoff: 'exponential' } };
  }

  // transient.element — stale element / animation race.
  if (/stale element|element is not attached|animation|detached from the dom|intercepts pointer/.test(msg)) {
    return { class: 'transient.element', recoverable: true, action: { kind: 'retry-once' } };
  }

  // unknown — capture artifacts and alert.
  return { class: 'unknown', recoverable: false, action: { kind: 'capture-and-alert' } };
}

/**
 * Whether a given attempt number should still be retried for a classified
 * failure. Encapsulates the retry-budget semantics of the recovery action.
 */
export function shouldRetry(failure: ClassifiedFailure, attempt: number): boolean {
  switch (failure.action.kind) {
    case 'retry':
      return attempt < failure.action.maxAttempts;
    case 'retry-once':
      return attempt < 1;
    case 'tier-platform':
      return attempt < 2; // one retry after tiering
    default:
      return false;
  }
}
