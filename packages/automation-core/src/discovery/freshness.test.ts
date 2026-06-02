import { describe, it, expect } from 'vitest';
import {
  classifyFreshness,
  isWithinFreshnessWindow,
  parseRelativePostedAt,
  resolvePostedAt,
  prioritize,
  tierRank,
  type FreshnessTier,
} from './freshness.js';

const NOW = new Date('2026-06-02T12:00:00.000Z');

describe('discovery/freshness', () => {
  it('classifies ages into the correct tiers', () => {
    const at = (hoursAgo: number): Date => new Date(NOW.getTime() - hoursAgo * 3_600_000);
    expect(classifyFreshness(at(2), NOW)).toBe('t5h');
    expect(classifyFreshness(at(8), NOW)).toBe('t12h');
    expect(classifyFreshness(at(20), NOW)).toBe('t24h');
    expect(classifyFreshness(at(72), NOW)).toBe('t5d');
    expect(classifyFreshness(at(24 * 6), NOW)).toBe('stale');
  });

  it('demotes uncertain postings exactly one tier', () => {
    const at = (hoursAgo: number): Date => new Date(NOW.getTime() - hoursAgo * 3_600_000);
    expect(classifyFreshness(at(2), NOW, true)).toBe('t12h'); // t5h → t12h
    expect(classifyFreshness(at(72), NOW, true)).toBe('stale'); // t5d → stale
  });

  it('treats null postedAt as t5d (certain) or stale (uncertain)', () => {
    expect(classifyFreshness(null, NOW, false)).toBe('t5d');
    expect(classifyFreshness(null, NOW, true)).toBe('stale');
  });

  it('isWithinFreshnessWindow excludes stale', () => {
    expect(isWithinFreshnessWindow('t5h')).toBe(true);
    expect(isWithinFreshnessWindow('stale')).toBe(false);
  });

  describe('parseRelativePostedAt', () => {
    it('parses hours/days/minutes ago', () => {
      expect(parseRelativePostedAt('2 hours ago', NOW)?.toISOString()).toBe('2026-06-02T10:00:00.000Z');
      expect(parseRelativePostedAt('1 day ago', NOW)?.toISOString()).toBe('2026-06-01T12:00:00.000Z');
      expect(parseRelativePostedAt('30 minutes ago', NOW)?.toISOString()).toBe('2026-06-02T11:30:00.000Z');
    });
    it('parses just now / yesterday', () => {
      expect(parseRelativePostedAt('just now', NOW)?.toISOString()).toBe(NOW.toISOString());
      expect(parseRelativePostedAt('yesterday', NOW)?.toISOString()).toBe('2026-06-01T12:00:00.000Z');
    });
    it('returns null for unparseable phrases', () => {
      expect(parseRelativePostedAt('whenever', NOW)).toBeNull();
    });
  });

  describe('resolvePostedAt', () => {
    it('prefers a valid absolute ISO time (certain)', () => {
      const r = resolvePostedAt({ absoluteIso: '2026-06-02T09:00:00.000Z' }, NOW);
      expect(r.uncertain).toBe(false);
      expect(r.postedAt?.toISOString()).toBe('2026-06-02T09:00:00.000Z');
    });
    it('falls back to relative (certain when parseable)', () => {
      const r = resolvePostedAt({ relativeText: '3 hours ago' }, NOW);
      expect(r.uncertain).toBe(false);
    });
    it('marks vague "recently" as uncertain at fetch time', () => {
      const r = resolvePostedAt({ relativeText: 'recently' }, NOW);
      expect(r.uncertain).toBe(true);
      expect(r.postedAt?.toISOString()).toBe(NOW.toISOString());
    });
    it('returns null+uncertain when nothing usable', () => {
      const r = resolvePostedAt({}, NOW);
      expect(r.postedAt).toBeNull();
      expect(r.uncertain).toBe(true);
    });
  });

  describe('prioritize', () => {
    it('orders by tier, then score desc, then id; drops stale', () => {
      const jobs = [
        { externalId: 'a', tier: 't24h' as FreshnessTier, score: 0.9 },
        { externalId: 'b', tier: 't5h' as FreshnessTier, score: 0.2 },
        { externalId: 'c', tier: 't5h' as FreshnessTier, score: 0.8 },
        { externalId: 'd', tier: 'stale' as FreshnessTier, score: 0.99 },
      ];
      const ordered = prioritize(jobs).map((j) => j.externalId);
      expect(ordered).toEqual(['c', 'b', 'a']); // stale 'd' dropped; t5h before t24h; within t5h score desc
    });
    it('tierRank: fresher tiers rank lower (higher priority)', () => {
      expect(tierRank('t5h')).toBeLessThan(tierRank('t12h'));
      expect(tierRank('t5d')).toBeLessThan(tierRank('stale'));
    });
  });
});
