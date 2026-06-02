import { describe, it, expect } from 'vitest';
import { redactValue } from './redaction.js';

describe('redaction (event-boundary value masking)', () => {
  it('masks emails keeping only first chars and tld', () => {
    expect(redactValue('alice@example.com')).toBe('a***@e***.com');
  });

  it('masks phones keeping the last 4 digits', () => {
    expect(redactValue('+91 98765 41234')).toBe('+**-***-***-1234');
    expect(redactValue('9876541234')).toBe('**-***-***-1234');
  });

  it('passes through short categorical answers (Yes/No)', () => {
    expect(redactValue('Yes')).toBe('Yes');
    expect(redactValue('No')).toBe('No');
  });

  it('generically masks longer free text', () => {
    const r = redactValue('Senior Engineer');
    expect(r.startsWith('S')).toBe(true);
    expect(r.endsWith('r')).toBe(true);
    expect(r).toContain('*');
  });

  it('returns empty for empty/whitespace', () => {
    expect(redactValue('   ')).toBe('');
  });

  it('never returns the raw sensitive value verbatim', () => {
    const raw = 'verysecretvalue@corp.com';
    expect(redactValue(raw)).not.toBe(raw);
  });
});
