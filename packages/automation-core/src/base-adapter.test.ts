import { describe, it, expect } from 'vitest';
import { BasePlatformAdapter, NO_CAPS } from './base-adapter.js';
import type {
  AdapterCaps,
  AdapterContext,
  ApplicationPlan,
  ApplyEligibility,
  DiscoveredJob,
  JobDetail,
  PlatformKey,
  SearchFilters,
  SessionState,
} from './contract.js';
import type { ApplyEvent } from './events.js';
import type { DetectionResult } from './safety/captcha.js';

// Minimal concrete adapter that exposes the protected helpers for testing.
class TestAdapter extends BasePlatformAdapter {
  readonly key: PlatformKey = 'linkedin';
  readonly version = '0.0.1';
  readonly capabilities: AdapterCaps = { ...NO_CAPS, quickApply: true };

  ensureSession(): Promise<SessionState> {
    return Promise.resolve({ status: 'authenticated', checkedAt: new Date(0) });
  }
  refreshSession(): Promise<SessionState> {
    return Promise.resolve({ status: 'authenticated', checkedAt: new Date(0) });
  }
  async *search(_ctx: AdapterContext, _f: SearchFilters): AsyncIterable<DiscoveredJob> {
    // no-op generator
  }
  parseListing(): DiscoveredJob {
    throw new Error('not used');
  }
  parseJob(): Promise<JobDetail> {
    return Promise.reject(new Error('not used'));
  }
  canApply(): Promise<ApplyEligibility> {
    return Promise.resolve({ kind: 'quick' });
  }
  async *apply(_c: AdapterContext, _j: JobDetail, _p: ApplicationPlan): AsyncIterable<ApplyEvent> {
    // no-op generator
  }

  // Expose protected helpers.
  publicChallengeToEvent(d: DetectionResult): ApplyEvent | null {
    return this.challengeToEvent(d);
  }
  publicEmitFilled(field: string, raw: string): ApplyEvent {
    return this.emitFilled(field, raw, 'user_intervention');
  }
}

describe('BasePlatformAdapter helpers', () => {
  const a = new TestAdapter();

  it('challengeToEvent maps a captcha to captcha.detected (never solve)', () => {
    const e = a.publicChallengeToEvent({ kind: 'captcha', confidence: 0.97, signal: 'iframe:recaptcha', provider: 'recaptcha' });
    expect(e?.kind).toBe('captcha.detected');
  });

  it('challengeToEvent maps otp/phone/email/security to human-required', () => {
    for (const kind of ['otp', 'phone', 'email', 'security'] as const) {
      const e = a.publicChallengeToEvent({ kind, confidence: 0.8, signal: 'x' });
      expect(e?.kind).toBe('human-required');
    }
  });

  it('challengeToEvent returns null when no challenge', () => {
    expect(a.publicChallengeToEvent({ kind: 'none', confidence: 0, signal: 'none' })).toBeNull();
  });

  it('emitFilled redacts the value at the event boundary', () => {
    const e = a.publicEmitFilled('email', 'alice@example.com');
    expect(e.kind).toBe('field.filled');
    if (e.kind === 'field.filled') {
      expect(e.valueRedacted).toBe('a***@e***.com');
      expect(e.valueRedacted).not.toContain('alice@example.com');
    }
  });
});
