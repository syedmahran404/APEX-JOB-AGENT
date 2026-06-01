// Per-user device fingerprint generator.
//
// Audit fix C2: the fingerprint is STABLE per user. We do not rotate
// fingerprints randomly because rotation itself looks like fraud. A
// rotation is only triggered by the compromise heuristic (CAPTCHA spike +
// low success rate); that path lives in the worker's safety module and
// invokes `regenerateFingerprint(userId, seed)` to produce a new profile.
//
// Determinism: the profile is derived from a seed (typically the user's
// UUID + a rotation counter) so the same input always yields the same
// profile. This lets us regenerate without persisting the bytes.

import { createHash } from 'node:crypto';
import type { BrowserFingerprintProfile } from '../managers/interfaces.js';

/** The set of plausible profiles. We pick deterministically from this list. */
const UA_POOL: ReadonlyArray<{
  ua: string;
  platform: 'Windows' | 'macOS' | 'Linux';
  hardwareConcurrency: number;
  deviceMemoryGb: number;
}> = [
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    platform: 'Windows',
    hardwareConcurrency: 8,
    deviceMemoryGb: 8,
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    platform: 'Windows',
    hardwareConcurrency: 12,
    deviceMemoryGb: 16,
  },
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    platform: 'macOS',
    hardwareConcurrency: 8,
    deviceMemoryGb: 16,
  },
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    platform: 'macOS',
    hardwareConcurrency: 10,
    deviceMemoryGb: 32,
  },
  {
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    platform: 'Linux',
    hardwareConcurrency: 8,
    deviceMemoryGb: 8,
  },
];

const VIEWPORT_POOL: ReadonlyArray<{ width: number; height: number }> = [
  { width: 1920, height: 1080 },
  { width: 1680, height: 1050 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
];

const TIMEZONE_POOL_BY_LOCALE: Readonly<Record<string, ReadonlyArray<string>>> = {
  'en-US': ['America/New_York', 'America/Chicago', 'America/Los_Angeles'],
  'en-GB': ['Europe/London'],
  'en-IN': ['Asia/Kolkata'],
  'en-CA': ['America/Toronto', 'America/Vancouver'],
  'en-AU': ['Australia/Sydney', 'Australia/Melbourne'],
};

export interface FingerprintInput {
  /** Stable user identifier — the seed for deterministic generation. */
  readonly userId: string;
  /** Bumped when the compromise heuristic forces a rotation. */
  readonly rotationCounter?: number;
  /** Locale hint from user preferences ("en-US" by default). */
  readonly locale?: string;
}

/**
 * Generate a deterministic fingerprint profile for a user. The same userId +
 * rotationCounter always returns the same profile. To rotate, increment the
 * counter — the per-user storage state will be invalidated separately by
 * the SessionManager.
 */
export function generateFingerprint(input: FingerprintInput): BrowserFingerprintProfile {
  const locale = input.locale ?? 'en-US';
  const seed = `${input.userId}|${(input.rotationCounter ?? 0).toString()}`;
  const digest = createHash('sha256').update(seed, 'utf8').digest();

  const ua = UA_POOL[digest[0]! % UA_POOL.length]!;
  const viewport = VIEWPORT_POOL[digest[1]! % VIEWPORT_POOL.length]!;
  const tzPool = TIMEZONE_POOL_BY_LOCALE[locale] ?? TIMEZONE_POOL_BY_LOCALE['en-US']!;
  const timezoneId = tzPool[digest[2]! % tzPool.length]!;
  // Color scheme is biased to dark for tech audiences but still split.
  const colorScheme: 'light' | 'dark' = (digest[3]! % 3 === 0 ? 'light' : 'dark');

  return {
    userAgent: ua.ua,
    viewport,
    timezoneId,
    locale,
    platform: ua.platform,
    hardwareConcurrency: ua.hardwareConcurrency,
    deviceMemoryGb: ua.deviceMemoryGb,
    colorScheme,
  };
}

/** Convenience: rotate the fingerprint by bumping the counter. */
export function regenerateFingerprint(
  userId: string,
  rotationCounter: number,
  locale = 'en-US',
): BrowserFingerprintProfile {
  return generateFingerprint({ userId, rotationCounter, locale });
}
