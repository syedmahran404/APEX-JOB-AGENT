import { describe, it, expect } from 'vitest';
import { classifyFailure, shouldRetry } from './failure-taxonomy.js';

describe('safety/failure-taxonomy (failure recovery)', () => {
  it('classifies DNS/reset/5xx as transient.network with exponential retry', () => {
    const f = classifyFailure({ message: 'getaddrinfo ENOTFOUND linkedin.com' });
    expect(f.class).toBe('transient.network');
    expect(f.recoverable).toBe(true);
    expect(f.action).toEqual({ kind: 'retry', maxAttempts: 3, backoff: 'exponential' });
  });

  it('classifies HTTP 503 as transient.network', () => {
    expect(classifyFailure({ message: 'server error', httpStatus: 503 }).class).toBe('transient.network');
  });

  it('classifies HTTP 429 as transient.platform with platform tiering', () => {
    const f = classifyFailure({ message: 'rate', httpStatus: 429 });
    expect(f.class).toBe('transient.platform');
    expect(f.action).toEqual({ kind: 'tier-platform', minutes: 15 });
  });

  it('classifies stale element as transient.element with retry-once', () => {
    const f = classifyFailure({ message: 'stale element reference: element is not attached to the DOM' });
    expect(f.class).toBe('transient.element');
    expect(f.action).toEqual({ kind: 'retry-once' });
  });

  it('classifies selector exhaustion as permanent.selector_drift and parks the adapter', () => {
    const f = classifyFailure({ message: 'easyApplyButton selector chain exhausted', selectorExhausted: true });
    expect(f.class).toBe('permanent.selector_drift');
    expect(f.recoverable).toBe(false);
    expect(f.action).toEqual({ kind: 'park-adapter' });
  });

  it('classifies low-confidence answer as permanent.policy skip', () => {
    const f = classifyFailure({ message: 'AI returned a low-confidence answer' });
    expect(f.class).toBe('permanent.policy');
    expect(f.action).toEqual({ kind: 'skip', reason: 'policy' });
  });

  it('classifies a flagged account as permanent.account and halts the platform', () => {
    const f = classifyFailure({ message: 'account is flagged for unusual activity' });
    expect(f.class).toBe('permanent.account');
    expect(f.action).toEqual({ kind: 'halt-platform', reason: 'account' });
  });

  it('classifies a persistent challenge as permanent.captcha pause-or-skip', () => {
    const f = classifyFailure({ message: 'challenge', captchaPersistent: true });
    expect(f.class).toBe('permanent.captcha');
    expect(f.action).toEqual({ kind: 'pause-or-skip' });
  });

  it('classifies anything else as unknown with capture-and-alert', () => {
    const f = classifyFailure({ message: 'totally weird thing happened' });
    expect(f.class).toBe('unknown');
    expect(f.action).toEqual({ kind: 'capture-and-alert' });
  });

  describe('shouldRetry honors the recovery budget', () => {
    it('retries network up to maxAttempts', () => {
      const f = classifyFailure({ message: 'econnreset' });
      expect(shouldRetry(f, 0)).toBe(true);
      expect(shouldRetry(f, 2)).toBe(true);
      expect(shouldRetry(f, 3)).toBe(false);
    });
    it('retries element only once', () => {
      const f = classifyFailure({ message: 'stale element' });
      expect(shouldRetry(f, 0)).toBe(true);
      expect(shouldRetry(f, 1)).toBe(false);
    });
    it('never retries permanent failures', () => {
      const f = classifyFailure({ message: 'account suspended' });
      expect(shouldRetry(f, 0)).toBe(false);
    });
  });
});
