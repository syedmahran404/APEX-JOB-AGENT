import { describe, it, expect } from 'vitest';
import {
  screenshotStorageKey,
  buildScreenshotMetadata,
  retentionDays,
  DEFAULT_SENSITIVE_SELECTORS,
} from './screenshots.js';

describe('runtime/screenshots', () => {
  it('derives a deterministic, secret-free storage key', () => {
    const key = screenshotStorageKey({
      userId: 'u-1',
      runId: 'r-1',
      seq: 3,
      reason: 'submission',
      platformKey: 'linkedin',
    });
    expect(key).toBe('screenshots/u-1/r-1/0003-submission-linkedin.png');
  });

  it('builds metadata with default sensitive selectors and ISO timestamp', () => {
    const meta = buildScreenshotMetadata({
      reason: 'failure',
      runId: 'r-1',
      userId: 'u-1',
      platformKey: 'linkedin',
      label: 'apply-step-2',
      capturedAt: new Date('2026-06-02T12:00:00.000Z'),
      seq: 1,
    });
    expect(meta.reason).toBe('failure');
    expect(meta.capturedAt).toBe('2026-06-02T12:00:00.000Z');
    expect(meta.storageKey).toContain('0001-failure-linkedin.png');
    expect(meta.sensitiveSelectors).toEqual(DEFAULT_SENSITIVE_SELECTORS);
    expect(meta.sensitiveSelectors).toContain('input[type="password"]');
  });

  it('honors custom sensitive selectors when provided', () => {
    const meta = buildScreenshotMetadata({
      reason: 'login',
      runId: 'r-1',
      userId: 'u-1',
      platformKey: 'naukri',
      label: 'login',
      capturedAt: new Date(0),
      seq: 0,
      sensitiveSelectors: ['#secret'],
    });
    expect(meta.sensitiveSelectors).toEqual(['#secret']);
  });

  it('retention: submissions kept longest, steps shortest', () => {
    expect(retentionDays('submission')).toBe(365);
    expect(retentionDays('failure')).toBe(90);
    expect(retentionDays('login')).toBe(30);
    expect(retentionDays('step')).toBe(14);
  });
});
