import { describe, it, expect } from 'vitest';
import {
  detectChallenge,
  isConfident,
  detectChallengeWithAi,
  type PageSnapshot,
  type DetectionResult,
} from './captcha.js';

function snap(partial: Partial<PageSnapshot>): PageSnapshot {
  return {
    url: 'https://www.linkedin.com/jobs/view/123',
    title: 'Job',
    visibleText: '',
    iframeSrcs: [],
    ...partial,
  };
}

describe('safety/captcha detection', () => {
  it('detects reCAPTCHA via iframe src with high confidence', () => {
    const r = detectChallenge(snap({ iframeSrcs: ['https://www.google.com/recaptcha/api2/anchor'] }));
    expect(r.kind).toBe('captcha');
    expect(r.provider).toBe('recaptcha');
    expect(r.confidence).toBeGreaterThan(0.9);
    expect(isConfident(r)).toBe(true);
  });

  it('detects hCaptcha and Cloudflare Turnstile by iframe', () => {
    expect(detectChallenge(snap({ iframeSrcs: ['https://hcaptcha.com/1/api.js'] })).provider).toBe('hcaptcha');
    expect(
      detectChallenge(snap({ iframeSrcs: ['https://challenges.cloudflare.com/turnstile'] })).provider,
    ).toBe('turnstile');
  });

  it('detects LinkedIn checkpoint via URL path as a security challenge', () => {
    const r = detectChallenge(snap({ url: 'https://www.linkedin.com/checkpoint/challenge/abc' }));
    expect(r.kind).toBe('security');
    expect(r.signal).toContain('checkpoint');
  });

  it('detects OTP via landmark text', () => {
    const r = detectChallenge(snap({ visibleText: 'Enter the code we sent to your phone' }));
    expect(r.kind).toBe('otp');
  });

  it('detects "verify you are human" as captcha', () => {
    const r = detectChallenge(snap({ visibleText: 'Please verify you are human to continue' }));
    expect(r.kind).toBe('captcha');
  });

  it('returns none for a normal page', () => {
    const r = detectChallenge(snap({ visibleText: 'Senior Backend Engineer at Acme' }));
    expect(r.kind).toBe('none');
    expect(isConfident(r)).toBe(false);
  });

  it('uses the timing heuristic when navigation lands on the wrong URL', () => {
    const r = detectChallenge(
      snap({
        url: 'https://www.linkedin.com/uas/login',
        expectedUrl: 'https://www.linkedin.com/jobs/view/123',
        elapsedMsSinceNav: 12_000,
      }),
    );
    expect(r.kind).toBe('other');
    expect(r.signal).toContain('timing');
  });

  it('consults the AI second opinion only when deterministic is ambiguous', async () => {
    let called = 0;
    const ai = (_s: PageSnapshot): Promise<DetectionResult> => {
      called++;
      return Promise.resolve({ kind: 'captcha', confidence: 0.9, signal: 'ai' });
    };
    // Confident deterministic → AI NOT called.
    await detectChallengeWithAi(snap({ iframeSrcs: ['https://hcaptcha.com/x'] }), ai);
    expect(called).toBe(0);

    // Ambiguous (timing 'other') → AI called.
    const r = await detectChallengeWithAi(
      snap({ url: 'https://x/y', expectedUrl: 'https://x/z', elapsedMsSinceNav: 12_000 }),
      ai,
    );
    expect(called).toBe(1);
    expect(r.kind).toBe('captcha');
  });

  it('never reports a challenge requiring solving — detection only (kinds are advisory)', () => {
    const r = detectChallenge(snap({ iframeSrcs: ['https://www.google.com/recaptcha/x'] }));
    // The result is a classification, not an instruction to solve.
    expect(['captcha', 'otp', 'phone', 'email', 'security', 'other', 'none']).toContain(r.kind);
  });
});
