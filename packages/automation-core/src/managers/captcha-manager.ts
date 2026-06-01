// CaptchaDetectionManager — DOM + URL heuristics for human-required gates.
// Audit fix C2 (Phase 6 §8): three-layer detection: DOM, URL, AI second
// opinion. Phase 2 ships layers 1+2; the AI layer plugs in via Phase 3.

import type { Page } from 'playwright';
import type { CaptchaDetectionManager, HumanRequiredKind } from './interfaces.js';

const DOM_SIGNALS: ReadonlyArray<{ kind: HumanRequiredKind; selectors: ReadonlyArray<string> }> = [
  {
    kind: 'captcha',
    selectors: [
      'iframe[src*="google.com/recaptcha"]',
      'iframe[src*="recaptcha"]',
      'iframe[src*="hcaptcha.com"]',
      'iframe[src*="cloudflare"]',
      '[class*="g-recaptcha"]',
      '[class*="h-captcha"]',
      '[id*="cf-challenge"]',
      'div#turnstile-widget',
    ],
  },
  {
    kind: 'otp',
    selectors: [
      'input[autocomplete="one-time-code"]',
      'input[name*="otp" i]',
      'input[id*="otp" i]',
      'input[placeholder*="OTP" i]',
      'input[placeholder*="one-time" i]',
    ],
  },
  {
    kind: 'phone',
    selectors: [
      'input[autocomplete="tel"][required]',
      'input[name*="phone" i][type="tel"][required]',
    ],
  },
  {
    kind: 'email',
    selectors: ['form[action*="verify-email" i]', 'input[name="verification_code" i]'],
  },
  {
    kind: 'security',
    selectors: [
      'form[action*="checkpoint" i]',
      'div[class*="challenge"]',
      '[data-test-id*="security-check"]',
    ],
  },
];

const URL_SIGNALS: ReadonlyArray<{ kind: HumanRequiredKind; patterns: ReadonlyArray<RegExp> }> = [
  { kind: 'captcha', patterns: [/captcha/i, /cloudflare\.com\/(?:l\/)?challenge/i, /turnstile/i] },
  { kind: 'otp', patterns: [/(?:otp|one[._-]?time)/i] },
  { kind: 'phone', patterns: [/verify[._-]?phone/i, /phone[._-]?verification/i] },
  { kind: 'email', patterns: [/verify[._-]?email/i, /email[._-]?verification/i] },
  { kind: 'security', patterns: [/checkpoint/i, /\/challenge\b/i] },
];

const TEXT_SIGNALS: ReadonlyArray<{ kind: HumanRequiredKind; phrases: ReadonlyArray<string> }> = [
  { kind: 'captcha', phrases: ["i'm not a robot", 'verify you are human', 'unusual traffic'] },
  { kind: 'otp', phrases: ['enter the code we sent', 'enter the verification code'] },
  { kind: 'phone', phrases: ['verify your phone number', 'we sent a code to your phone'] },
  { kind: 'email', phrases: ['verify your email', 'check your email for a code'] },
  { kind: 'security', phrases: ['security check', 'unusual sign-in attempt'] },
];

export class DefaultCaptchaDetectionManager implements CaptchaDetectionManager {
  async detect(page: Page): Promise<HumanRequiredKind> {
    // 1. URL — fastest, no DOM query.
    const url = page.url();
    for (const { kind, patterns } of URL_SIGNALS) {
      if (patterns.some((p) => p.test(url))) return kind;
    }

    // 2. DOM selectors.
    for (const { kind, selectors } of DOM_SIGNALS) {
      for (const sel of selectors) {
        try {
          const count = await page.locator(sel).count();
          if (count > 0) return kind;
        } catch {
          // ignore selector errors
        }
      }
    }

    // 3. Visible text signals on the body. Capped at 8 KB to keep this cheap.
    try {
      const text = await page.evaluate(() => document.body?.innerText?.slice(0, 8192) ?? '');
      const lowered = text.toLowerCase();
      for (const { kind, phrases } of TEXT_SIGNALS) {
        if (phrases.some((p) => lowered.includes(p))) return kind;
      }
    } catch {
      // ignore evaluate failure
    }

    return 'none';
  }
}
