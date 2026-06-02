import { describe, it, expect } from 'vitest';
import { generateDeviceProfile, buildAcceptLanguage, DEVICE_PROFILE_VERSION } from './identity.js';

describe('anti-detection/identity', () => {
  it('is deterministic: same user → identical profile (no random rotation)', () => {
    const a = generateDeviceProfile({ userId: 'user-123' });
    const b = generateDeviceProfile({ userId: 'user-123' });
    expect(a).toEqual(b);
    expect(a.version).toBe(DEVICE_PROFILE_VERSION);
  });

  it('produces different profiles for different users (with very high probability)', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `user-${String(i)}`);
    const profiles = new Set(ids.map((id) => JSON.stringify(generateDeviceProfile({ userId: id }))));
    // Not all identical — the generator spreads across the option pools.
    expect(profiles.size).toBeGreaterThan(1);
  });

  it('honors a stated timezone and locale rather than deriving them', () => {
    const p = generateDeviceProfile({ userId: 'u', timezone: 'Europe/Berlin', locale: 'de-DE' });
    expect(p.timezone).toBe('Europe/Berlin');
    expect(p.languages[0]).toBe('de-DE');
    expect(p.languages).toContain('de');
    expect(p.acceptLanguage.startsWith('de-DE')).toBe(true);
  });

  it('produces a plausible Chrome desktop UA and 24-bit color depth', () => {
    const p = generateDeviceProfile({ userId: 'ua-check' });
    expect(p.userAgent).toMatch(/Chrome\/\d+\.\d+\.\d+\.\d+ Safari\/537\.36/);
    expect(p.platform).toBe('Win32');
    expect(p.screen.colorDepth).toBe(24);
    expect([4, 8]).toContain(p.deviceMemory);
    expect([4, 8, 12, 16]).toContain(p.hardwareConcurrency);
  });

  it('buildAcceptLanguage assigns descending q-values', () => {
    expect(buildAcceptLanguage(['en-IN', 'en'])).toBe('en-IN,en;q=0.9');
    expect(buildAcceptLanguage(['fr-FR'])).toBe('fr-FR');
  });
});
