import { describe, expect, it } from 'vitest';
import { parsePostedTime } from '../parse-posted-time.js';

const NOW = new Date('2026-06-01T12:00:00Z');

describe('parsePostedTime', () => {
  it('prefers absolute datetime when present', () => {
    const r = parsePostedTime('2 days ago', '2026-05-31T08:30:00Z', NOW);
    expect(r).not.toBeNull();
    expect(r?.uncertain).toBe(false);
    expect(r?.at.toISOString()).toBe('2026-05-31T08:30:00.000Z');
  });

  it('parses "just now"', () => {
    const r = parsePostedTime('just now', null, NOW);
    expect(r?.uncertain).toBe(true);
    expect(r?.at.getTime()).toBe(NOW.getTime());
  });

  it('parses "4 hours ago"', () => {
    const r = parsePostedTime('Posted 4 hours ago', null, NOW);
    expect(r?.uncertain).toBe(true);
    const ageHours = (NOW.getTime() - (r?.at.getTime() ?? 0)) / 3_600_000;
    expect(ageHours).toBeCloseTo(4, 5);
  });

  it('parses "2 days ago"', () => {
    const r = parsePostedTime('2 days ago', null, NOW);
    const ageDays = (NOW.getTime() - (r?.at.getTime() ?? 0)) / (24 * 3_600_000);
    expect(ageDays).toBeCloseTo(2, 5);
  });

  it('returns null for unparseable text', () => {
    expect(parsePostedTime('apple banana', null, NOW)).toBeNull();
  });

  it('treats "Reposted" as moderately old', () => {
    const r = parsePostedTime('Reposted', null, NOW);
    expect(r?.uncertain).toBe(true);
    const ageHours = (NOW.getTime() - (r?.at.getTime() ?? 0)) / 3_600_000;
    expect(ageHours).toBeCloseTo(24, 1);
  });
});
