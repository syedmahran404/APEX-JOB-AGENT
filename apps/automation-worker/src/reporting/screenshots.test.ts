import { describe, it, expect } from 'vitest';
import { ScreenshotCapturer, type ArtifactStore } from './screenshots.js';
import { FakePage } from '../browser/fake-driver.js';

function fakeStore(): ArtifactStore & { puts: Array<{ key: string; type: string }> } {
  const puts: Array<{ key: string; type: string }> = [];
  return {
    puts,
    put(key, _bytes, contentType): Promise<{ sha256: string }> {
      puts.push({ key, type: contentType });
      return Promise.resolve({ sha256: 'deadbeef' });
    },
  };
}

describe('reporting/ScreenshotCapturer', () => {
  it('captures with sensitive selectors masked, uploads, returns metadata + hash', async () => {
    const store = fakeStore();
    const page = new FakePage();
    const capturer = new ScreenshotCapturer({
      store,
      clock: () => new Date('2026-06-02T12:00:00.000Z'),
      sensitiveSelectors: ['input[type="password"]'],
    });
    const meta = await capturer.capture({
      page,
      reason: 'submission',
      runId: 'r-1',
      userId: 'u-1',
      platformKey: 'linkedin',
      label: 'submitted',
      applicationId: 'app-1',
      seq: 2,
    });
    expect(meta.storageKey).toBe('screenshots/u-1/r-1/0002-submission-linkedin.png');
    expect(meta.sha256).toBe('deadbeef');
    expect(store.puts[0]?.type).toBe('image/png');
    // The page screenshot was asked to mask the sensitive selector.
    expect(page.screenshots[0]?.maskSelectors).toContain('input[type="password"]');
  });
});
