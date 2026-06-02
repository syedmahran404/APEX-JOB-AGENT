import { describe, it, expect } from 'vitest';
import {
  parseListing,
  parseJob,
  detectApplyKind,
  extractJobId,
  normalizeRemoteKind,
  type RawLinkedInJob,
} from './parse.js';
import listingsFixture from './fixtures/listings.json' assert { type: 'json' };
import jobsFixture from './fixtures/jobs.json' assert { type: 'json' };

const NOW = new Date('2026-06-02T12:00:00.000Z');

describe('linkedin/parse — extractJobId', () => {
  it('extracts from entity urn', () => {
    expect(extractJobId({ entityId: 'urn:li:jobPosting:3856120947' })).toBe('3856120947');
  });
  it('extracts from /jobs/view/ slug url', () => {
    expect(extractJobId({ url: 'https://www.linkedin.com/jobs/view/senior-eng-3856120947' })).toBe('3856120947');
  });
  it('extracts from currentJobId query param', () => {
    expect(extractJobId({ url: 'https://www.linkedin.com/jobs/search/?currentJobId=4001234567' })).toBe('4001234567');
  });
  it('returns null when no id present', () => {
    expect(extractJobId({ url: 'https://www.linkedin.com/jobs/' })).toBeNull();
  });
});

describe('linkedin/parse — normalizeRemoteKind', () => {
  it('maps workplace badges', () => {
    expect(normalizeRemoteKind('Remote')).toBe('remote');
    expect(normalizeRemoteKind('Hybrid')).toBe('hybrid');
    expect(normalizeRemoteKind('On-site')).toBe('onsite');
    expect(normalizeRemoteKind(undefined)).toBeUndefined();
  });
});

describe('linkedin/parse — parseListing (fixture-driven)', () => {
  for (const fixture of listingsFixture.listings) {
    it(`normalizes "${fixture.name}"`, () => {
      const job = parseListing(fixture.raw, NOW);
      const e = fixture.expect as Record<string, unknown>;
      expect(job.externalId).toBe(e.externalId);
      expect(job.platformKey).toBe('linkedin');
      if (e.title !== undefined) expect(job.title).toBe(e.title);
      if (e.company !== undefined) expect(job.company).toBe(e.company);
      if (e.remoteKind !== undefined) expect(job.remoteKind).toBe(e.remoteKind);
      if (e.postedAtUncertain !== undefined) expect(job.postedAtUncertain).toBe(e.postedAtUncertain);
      expect(job.url).toContain(job.externalId);
    });
  }

  it('throws on a listing with no derivable id', () => {
    expect(() => parseListing({ title: 'X', company: 'Y' }, NOW)).toThrowError(/job id/);
  });

  it('throws when a required field is missing', () => {
    expect(() => parseListing({ url: 'https://www.linkedin.com/jobs/view/123456', company: 'Y' }, NOW)).toThrowError(
      /title/,
    );
  });
});

describe('linkedin/parse — detectApplyKind + parseJob (fixture-driven)', () => {
  for (const fixture of jobsFixture.jobs) {
    it(`detects apply kind for "${fixture.name}"`, () => {
      expect(detectApplyKind(fixture.raw as RawLinkedInJob)).toBe(fixture.expectApplyKind);
    });
  }

  it('parseJob carries description, salary, and applyKind', () => {
    const easy = jobsFixture.jobs.find((j) => j.name === 'easy_apply_open');
    expect(easy).toBeDefined();
    const detail = parseJob(easy!.raw, NOW);
    expect(detail.applyKind).toBe('quick');
    expect(detail.description.length).toBeGreaterThan(0);
    expect(detail.salaryText).toContain('INR');
    expect(detail.externalId).toBe('3856120947');
  });
});
