// CAPTCHA / OTP / verification detection. Layered heuristics over a page
// snapshot (DOM iframe sources, landmark texts, URL paths, timing). The AI
// "second opinion" is an injected, optional async callback so this module stays
// pure and unit-testable; the worker supplies the real classifier.
//
// We DETECT and YIELD. We never solve. Reference: §8.

export type ChallengeKind = 'none' | 'captcha' | 'otp' | 'phone' | 'email' | 'security' | 'other';

/** A minimal, browser-free snapshot of the page used for detection. */
export interface PageSnapshot {
  url: string;
  title: string;
  /** Visible h1/landmark text, lowercased by the caller or here. */
  visibleText: string;
  /** `src` attributes of iframes on the page. */
  iframeSrcs: string[];
  /** Time since navigation began, ms (for the timing heuristic). */
  elapsedMsSinceNav?: number | undefined;
  /** The URL we expected to land on; a mismatch raises suspicion. */
  expectedUrl?: string | undefined;
}

export interface DetectionResult {
  kind: ChallengeKind;
  /** 0..1 confidence. */
  confidence: number;
  /** What fired the detection, for forensics. */
  signal: string;
  provider?: string | undefined;
}

const IFRAME_PROVIDERS: Array<{ match: string; provider: string }> = [
  { match: 'google.com/recaptcha', provider: 'recaptcha' },
  { match: 'recaptcha.net', provider: 'recaptcha' },
  { match: 'hcaptcha.com', provider: 'hcaptcha' },
  { match: 'challenges.cloudflare.com', provider: 'turnstile' },
  { match: 'cloudflare-challenge', provider: 'cloudflare' },
  { match: 'arkoselabs.com', provider: 'arkose' },
  { match: 'funcaptcha', provider: 'arkose' },
];

const LANDMARK_PATTERNS: Array<{ re: RegExp; kind: ChallengeKind; signal: string }> = [
  { re: /verify you (are|'re) (a )?human/i, kind: 'captcha', signal: 'landmark:human' },
  { re: /i'?m not a robot/i, kind: 'captcha', signal: 'landmark:robot' },
  { re: /complete the (security )?check/i, kind: 'captcha', signal: 'landmark:securitycheck' },
  { re: /enter the (code|otp)( we sent)?/i, kind: 'otp', signal: 'landmark:otp' },
  { re: /verification code/i, kind: 'otp', signal: 'landmark:otp' },
  { re: /confirm your phone( number)?/i, kind: 'phone', signal: 'landmark:phone' },
  { re: /verify your email/i, kind: 'email', signal: 'landmark:email' },
  { re: /unusual (login|activity)/i, kind: 'security', signal: 'landmark:security' },
  { re: /let'?s do a quick security check/i, kind: 'security', signal: 'landmark:security' },
];

const URL_PATTERNS: Array<{ re: RegExp; kind: ChallengeKind; signal: string }> = [
  { re: /\/checkpoint\//i, kind: 'security', signal: 'url:checkpoint' }, // LinkedIn
  { re: /\/challenge\//i, kind: 'captcha', signal: 'url:challenge' },
  { re: /\/captcha/i, kind: 'captcha', signal: 'url:captcha' },
  { re: /\/(otp|verify)/i, kind: 'otp', signal: 'url:verify' },
];

/**
 * Synchronous, deterministic detection from DOM/URL/landmark/timing heuristics.
 * Returns the highest-confidence signal. `{ kind: 'none' }` when nothing fires.
 */
export function detectChallenge(snapshot: PageSnapshot): DetectionResult {
  const text = snapshot.visibleText.toLowerCase();

  // 1. iframe provider match — highest confidence.
  for (const { match, provider } of IFRAME_PROVIDERS) {
    if (snapshot.iframeSrcs.some((src) => src.toLowerCase().includes(match))) {
      return { kind: 'captcha', confidence: 0.97, signal: `iframe:${provider}`, provider };
    }
  }

  // 2. URL path heuristics — high confidence.
  for (const { re, kind, signal } of URL_PATTERNS) {
    if (re.test(snapshot.url)) {
      return { kind, confidence: 0.85, signal };
    }
  }

  // 3. Landmark text heuristics — medium-high confidence.
  for (const { re, kind, signal } of LANDMARK_PATTERNS) {
    if (re.test(text)) {
      return { kind, confidence: 0.8, signal };
    }
  }

  // 4. Timing heuristic — navigation didn't reach the expected URL in budget.
  if (
    snapshot.expectedUrl !== undefined &&
    snapshot.elapsedMsSinceNav !== undefined &&
    snapshot.elapsedMsSinceNav > 8000 &&
    !urlsMatchPath(snapshot.url, snapshot.expectedUrl)
  ) {
    return { kind: 'other', confidence: 0.4, signal: 'timing:landing-mismatch' };
  }

  return { kind: 'none', confidence: 0.0, signal: 'none' };
}

/** True when the deterministic signal is confident enough to act without AI. */
export function isConfident(result: DetectionResult, threshold = 0.75): boolean {
  return result.kind !== 'none' && result.confidence >= threshold;
}

export type AiSecondOpinion = (snapshot: PageSnapshot) => Promise<DetectionResult>;

/**
 * Full detection: trust a confident deterministic signal; otherwise (ambiguous)
 * consult the optional AI second opinion. When the deterministic result is a
 * clean 'none' and no AI is supplied, returns 'none'.
 */
export async function detectChallengeWithAi(
  snapshot: PageSnapshot,
  ai?: AiSecondOpinion,
): Promise<DetectionResult> {
  const deterministic = detectChallenge(snapshot);
  if (isConfident(deterministic)) return deterministic;
  if (ai && (deterministic.kind === 'other' || deterministic.kind === 'none')) {
    return ai(snapshot);
  }
  return deterministic;
}

function urlsMatchPath(a: string, b: string): boolean {
  try {
    return new URL(a).pathname === new URL(b).pathname;
  } catch {
    return a === b;
  }
}
