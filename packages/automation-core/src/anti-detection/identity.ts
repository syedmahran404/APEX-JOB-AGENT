// Identity layer — the static, per-user device fingerprint.
//
// Reference: docs/architecture/06-automation-engine.md §6.1.
//
// Key property: the profile is DETERMINISTIC per user. We derive every field
// from a stable hash of the user id (+ a versioned salt), so the same user
// always presents the same device. We never randomly rotate — rotation looks
// like fraud. This module is pure (no browser, no I/O) and fully unit-testable.

import { createHash } from 'node:crypto';

/** Bump when the generation algorithm changes; old users keep their profile via stored copy. */
export const DEVICE_PROFILE_VERSION = 1;

export interface DeviceProfile {
  version: number;
  userAgent: string;
  platform: string;
  languages: string[];
  /** IANA timezone, aligned to the user's stated timezone when provided. */
  timezone: string;
  hardwareConcurrency: number;
  /** GB, as exposed by navigator.deviceMemory (one of 2/4/8). */
  deviceMemory: number;
  screen: { width: number; height: number; colorDepth: number };
  /** Accept-Language header value derived from `languages`. */
  acceptLanguage: string;
}

export interface DeviceProfileInput {
  userId: string;
  /** The user's stated timezone (IANA). When absent, derived deterministically. */
  timezone?: string | undefined;
  /** Preferred locale, e.g. "en-IN". When absent, derived deterministically. */
  locale?: string | undefined;
}

// Curated, realistic option pools. Kept deliberately small and plausible —
// these are common desktop Chrome configurations, not exotic ones.
const CHROME_VERSIONS = ['124.0.0.0', '125.0.0.0', '126.0.0.0'] as const;
const SCREEN_RESOLUTIONS = [
  { width: 1920, height: 1080 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 2560, height: 1440 },
] as const;
const HARDWARE_CONCURRENCY = [4, 8, 12, 16] as const;
const DEVICE_MEMORY = [4, 8] as const;
const FALLBACK_TIMEZONES = ['Asia/Kolkata', 'America/New_York', 'Europe/London', 'America/Los_Angeles'] as const;
const FALLBACK_LOCALES = ['en-IN', 'en-US', 'en-GB'] as const;

/** Deterministic 32-bit unsigned int derived from (userId, field). */
function hashInt(userId: string, field: string): number {
  const h = createHash('sha256').update(`${String(DEVICE_PROFILE_VERSION)}:${userId}:${field}`).digest();
  // First 4 bytes as an unsigned int.
  return ((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0;
}

function pick<T>(userId: string, field: string, pool: readonly T[]): T {
  const idx = hashInt(userId, field) % pool.length;
  return pool[idx]!;
}

/**
 * Generate a stable device profile for a user. Same input → same output, always.
 * Stored once per user (platform_sessions / device profile table); this function
 * is the canonical generator used on first creation and in tests.
 */
export function generateDeviceProfile(input: DeviceProfileInput): DeviceProfile {
  const { userId } = input;
  const chrome = pick(userId, 'chrome', CHROME_VERSIONS);
  const resolution = pick(userId, 'screen', SCREEN_RESOLUTIONS);
  const hardwareConcurrency = pick(userId, 'cores', HARDWARE_CONCURRENCY);
  const deviceMemory = pick(userId, 'memory', DEVICE_MEMORY);
  const timezone = input.timezone ?? pick(userId, 'tz', FALLBACK_TIMEZONES);
  const locale = input.locale ?? pick(userId, 'locale', FALLBACK_LOCALES);

  // Secondary language is the base language of the primary locale.
  const baseLang = locale.split('-')[0] ?? 'en';
  const languages = locale === baseLang ? [locale] : [locale, baseLang];

  const userAgent =
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${chrome} Safari/537.36`;

  return {
    version: DEVICE_PROFILE_VERSION,
    userAgent,
    platform: 'Win32',
    languages,
    timezone,
    hardwareConcurrency,
    deviceMemory,
    screen: { width: resolution.width, height: resolution.height, colorDepth: 24 },
    acceptLanguage: buildAcceptLanguage(languages),
  };
}

/** Build an Accept-Language header with descending q-values. */
export function buildAcceptLanguage(languages: string[]): string {
  return languages
    .map((lang, i) => (i === 0 ? lang : `${lang};q=${(1 - i * 0.1).toFixed(1)}`))
    .join(',');
}
