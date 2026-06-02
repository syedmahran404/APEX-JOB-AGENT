import { describe, it, expect } from 'vitest';
import type { AdapterContext } from '@apex/automation-core';
import { isApexError } from '@apex/shared-errors';
import { LinkedInAdapter, LINKEDIN_CAPS, LINKEDIN_ADAPTER_VERSION, browserRuntimeRequired } from './adapter.js';
import { LINKEDIN_SELECTORS, LINKEDIN_SENSITIVE_SELECTORS } from './selectors.js';

/** A browser-free context stub: only clock/logger/random are needed for pure paths. */
function stubContext(now: Date): AdapterContext {
  return {
    userId: 'u-1',
    platformKey: 'linkedin',
    profile: 'STRICT_DEFAULT',
    page: null,
    browserContext: null,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    clock: { now: () => now },
    random: { next: () => 0.5 },
    cancellation: { cancelled: false, throwIfCancelled() {} },
  };
}

describe('LinkedInAdapter', () => {
  const adapter = new LinkedInAdapter();

  it('declares the expected capabilities and version', () => {
    expect(adapter.key).toBe('linkedin');
    expect(adapter.version).toBe(LINKEDIN_ADAPTER_VERSION);
    expect(adapter.capabilities).toEqual(LINKEDIN_CAPS);
    expect(adapter.capabilities.quickApply).toBe(true);
    expect(adapter.capabilities.resumeUpload).toBe(true);
  });

  it('exposes the selector catalog and sensitive selectors for the worker', () => {
    expect(adapter.selectors).toBe(LINKEDIN_SELECTORS);
    expect(adapter.sensitiveSelectors).toBe(LINKEDIN_SENSITIVE_SELECTORS);
    // Easy Apply selector prefers a stable test id.
    expect(LINKEDIN_SELECTORS.easyApplyButton.strategies[0]?.kind).toBe('testid');
  });

  it('parseListing (pure) normalizes via the injected clock', () => {
    const ctx = stubContext(new Date('2026-06-02T12:00:00.000Z'));
    const job = adapter.parseListing(ctx, {
      url: 'https://www.linkedin.com/jobs/view/3856120947',
      title: 'Backend Engineer',
      company: 'Acme Corp',
      postedRelative: '2 hours ago',
      workplaceType: 'Remote',
    });
    expect(job.externalId).toBe('3856120947');
    expect(job.remoteKind).toBe('remote');
    expect(job.postedAtUncertain).toBe(false);
  });

  it('browser-driving methods fail honestly with a typed DependencyError (no Playwright runtime)', async () => {
    const ctx = stubContext(new Date(0));
    await expect(adapter.ensureSession(ctx)).rejects.toMatchObject({ code: 'dependency_unavailable' });
    await expect(adapter.parseJob(ctx, 'https://x')).rejects.toMatchObject({ code: 'dependency_unavailable' });
    expect(() => adapter.search(ctx, { query: 'go' })).toThrowError(/Playwright runtime/);
    expect(() => adapter.apply(ctx, {} as never, {} as never)).toThrowError(/Playwright runtime/);
    // It is a proper ApexError from the shared hierarchy, not a raw Error.
    expect(isApexError(browserRuntimeRequired('x'))).toBe(true);
  });
});
