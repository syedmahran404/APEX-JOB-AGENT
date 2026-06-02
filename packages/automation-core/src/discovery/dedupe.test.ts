import { describe, it, expect } from 'vitest';
import { normalizeToken, canonicalJobKey, dedupeJobs, type SeenIndex } from './dedupe.js';

describe('discovery/dedupe', () => {
  it('normalizeToken lowercases, strips company suffixes and punctuation', () => {
    expect(normalizeToken('Acme Corp.')).toBe('acme');
    expect(normalizeToken('Globex, LLC')).toBe('globex');
    expect(normalizeToken('Hooli   Inc')).toBe('hooli');
    expect(normalizeToken('Señor Developer')).toBe('senor developer');
  });

  it('canonicalJobKey collapses the same role+company across platforms', () => {
    const a = canonicalJobKey({ title: 'Senior Backend Engineer', company: 'Acme Corp', location: 'Bengaluru' });
    const b = canonicalJobKey({ title: 'senior backend engineer', company: 'Acme, Inc', location: 'bengaluru' });
    expect(a).toBe(b);
  });

  it('different roles produce different keys', () => {
    const a = canonicalJobKey({ title: 'Backend Engineer', company: 'Acme' });
    const b = canonicalJobKey({ title: 'Frontend Engineer', company: 'Acme' });
    expect(a).not.toBe(b);
  });

  it('dedupeJobs skips already-seen external ids', () => {
    const seen: SeenIndex = { externalIds: new Set(['111']), canonicalKeys: new Set() };
    const result = dedupeJobs(
      [
        { externalId: '111', title: 'A', company: 'X' },
        { externalId: '222', title: 'B', company: 'Y' },
      ],
      seen,
    );
    expect(result.fresh.map((j) => j.externalId)).toEqual(['222']);
    expect(result.duplicates[0]?.reason).toBe('external_id_seen');
  });

  it('dedupeJobs collapses cross-platform duplicates within a batch (first wins)', () => {
    const seen: SeenIndex = { externalIds: new Set(), canonicalKeys: new Set() };
    const result = dedupeJobs(
      [
        { externalId: 'li-1', title: 'Data Engineer', company: 'Acme Corp', location: 'Pune' },
        { externalId: 'nk-9', title: 'data engineer', company: 'Acme, Inc.', location: 'pune' },
      ],
      seen,
    );
    expect(result.fresh.map((j) => j.externalId)).toEqual(['li-1']);
    expect(result.duplicates[0]?.reason).toBe('canonical_key_seen');
  });

  it('respects canonical keys already applied in prior runs', () => {
    const priorKey = canonicalJobKey({ title: 'SRE', company: 'Initech' });
    const seen: SeenIndex = { externalIds: new Set(), canonicalKeys: new Set([priorKey]) };
    const result = dedupeJobs([{ externalId: 'x', title: 'SRE', company: 'Initech' }], seen);
    expect(result.fresh).toHaveLength(0);
    expect(result.duplicates).toHaveLength(1);
  });
});
