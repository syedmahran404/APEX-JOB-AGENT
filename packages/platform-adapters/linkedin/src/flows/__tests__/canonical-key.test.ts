import { describe, expect, it } from 'vitest';
import { buildCanonicalKey } from '../canonical-key.js';

describe('buildCanonicalKey', () => {
  it('groups title variants by level', () => {
    const a = buildCanonicalKey({ company: 'ACME Inc.', title: 'Senior Software Engineer', location: 'Bengaluru, KA, India' });
    const b = buildCanonicalKey({ company: 'ACME Inc.', title: 'Staff Software Engineer', location: 'Bangalore, India' });
    expect(a).toBe(b);
  });

  it('groups variant city names', () => {
    const a = buildCanonicalKey({ company: 'ACME Inc.', title: 'Software Engineer', location: 'Mumbai, MH' });
    const b = buildCanonicalKey({ company: 'ACME Inc.', title: 'Software Engineer', location: 'Bombay' });
    expect(a).toBe(b);
  });

  it('strips Inc/Ltd/Pvt suffixes from employer', () => {
    const a = buildCanonicalKey({ company: 'ACME Inc.', title: 'SDE', location: 'Pune' });
    const b = buildCanonicalKey({ company: 'ACME', title: 'SDE', location: 'Pune' });
    expect(a).toBe(b);
  });

  it('returns empty when employer is missing', () => {
    expect(buildCanonicalKey({ company: null, title: 'Engineer', location: 'X' })).toBe('');
  });

  it('returns empty when title is empty', () => {
    expect(buildCanonicalKey({ company: 'A', title: '', location: 'X' })).toBe('');
  });

  it('treats remote variants as one bucket', () => {
    const a = buildCanonicalKey({ company: 'A', title: 'Engineer', location: 'Remote, USA' });
    const b = buildCanonicalKey({ company: 'A', title: 'Engineer', location: 'Anywhere' });
    expect(a).toBe(b);
  });
});
