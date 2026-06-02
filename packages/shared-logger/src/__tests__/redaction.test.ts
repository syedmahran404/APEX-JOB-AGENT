import { describe, expect, it } from 'vitest';
import { REDACT_PATHS, scrubEnvelopedFields } from '../redaction.js';

describe('redaction', () => {
  it('REDACT_PATHS covers expected sensitive keys', () => {
    expect(REDACT_PATHS).toContain('*.password');
    expect(REDACT_PATHS).toContain('*.token');
    expect(REDACT_PATHS).toContain('*.cipher');
    expect(REDACT_PATHS).toContain('*.phone');
    expect(REDACT_PATHS).toContain('*.dob');
    expect(REDACT_PATHS).toContain('*.cookie');
  });

  it('scrubEnvelopedFields strips _enc and _wrapped keys', () => {
    const out = scrubEnvelopedFields({
      id: '123',
      phone: '+91-99999-99999',
      phone_e164_enc: Buffer.from('cipher'),
      data_key_wrapped: Buffer.from('cipher'),
      profile: {
        addressEnc: 'cipher',
        nameWrapped: 'cipher',
        nested: { dobEnc: 'cipher', kept: 'ok' },
      },
    });
    expect(out).toEqual({
      id: '123',
      phone: '+91-99999-99999',
      profile: {
        nested: { kept: 'ok' },
      },
    });
  });

  it('scrubEnvelopedFields handles arrays', () => {
    const out = scrubEnvelopedFields([{ aEnc: 'x', b: 1 }, { aEnc: 'y', b: 2 }]);
    expect(out).toEqual([{ b: 1 }, { b: 2 }]);
  });

  it('scrubEnvelopedFields is a no-op for primitives', () => {
    expect(scrubEnvelopedFields(42)).toBe(42);
    expect(scrubEnvelopedFields('s')).toBe('s');
    expect(scrubEnvelopedFields(null)).toBeNull();
  });
});
