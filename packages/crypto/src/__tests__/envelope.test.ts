import { describe, expect, it } from 'vitest';
import { generateDek, encrypt, decrypt, buildAad, deriveSubkey, type AadFields } from '../index.js';
import { CryptoError } from '../errors.js';

const aad: AadFields = {
  domain: 'platform_credentials',
  identity: ['00000000-0000-4000-8000-000000000001', '1'],
  rotationVersion: 1,
};

describe('envelope encryption', () => {
  it('round-trips bytes with correct AAD', () => {
    const dek = generateDek('vault:test/dek', 1);
    const sealed = encrypt({ dek, purpose: 'dek-credentials', aad, plaintext: Buffer.from('s3cr3t') });
    const open = decrypt({ dek, purpose: 'dek-credentials', aad, sealed });
    expect(open.toString('utf8')).toBe('s3cr3t');
  });

  it('round-trips strings', () => {
    const dek = generateDek('vault:test/dek', 1);
    const sealed = encrypt({ dek, purpose: 'dek-personal', aad, plaintext: 'hello' });
    expect(decrypt({ dek, purpose: 'dek-personal', aad, sealed }).toString('utf8')).toBe('hello');
  });

  it('rejects mismatched AAD identity', () => {
    const dek = generateDek('vault:test/dek', 1);
    const sealed = encrypt({ dek, purpose: 'dek-credentials', aad, plaintext: 'x' });
    const wrong: AadFields = { ...aad, identity: ['00000000-0000-4000-8000-000000000002', '1'] };
    expect(() => decrypt({ dek, purpose: 'dek-credentials', aad: wrong, sealed })).toThrow(CryptoError);
  });

  it('rejects mismatched rotation version', () => {
    const dek = generateDek('vault:test/dek', 1);
    const sealed = encrypt({ dek, purpose: 'dek-credentials', aad, plaintext: 'x' });
    const wrong: AadFields = { ...aad, rotationVersion: 2 };
    expect(() => decrypt({ dek, purpose: 'dek-credentials', aad: wrong, sealed })).toThrow(CryptoError);
  });

  it('rejects mismatched purpose (subkey separation)', () => {
    const dek = generateDek('vault:test/dek', 1);
    const sealed = encrypt({ dek, purpose: 'dek-credentials', aad, plaintext: 'x' });
    expect(() => decrypt({ dek, purpose: 'dek-personal', aad, sealed })).toThrow(CryptoError);
  });

  it('rejects different DEK', () => {
    const a = generateDek('vault:test/dek', 1);
    const b = generateDek('vault:test/dek', 1);
    const sealed = encrypt({ dek: a, purpose: 'dek-credentials', aad, plaintext: 'x' });
    expect(() => decrypt({ dek: b, purpose: 'dek-credentials', aad, sealed })).toThrow(CryptoError);
  });

  it('produces different ciphertexts for repeated encrypts (random nonce)', () => {
    const dek = generateDek('vault:test/dek', 1);
    const a = encrypt({ dek, purpose: 'dek-credentials', aad, plaintext: 'x' });
    const b = encrypt({ dek, purpose: 'dek-credentials', aad, plaintext: 'x' });
    expect(a.equals(b)).toBe(false);
  });

  it('detects truncated sealed buffer', () => {
    const dek = generateDek('vault:test/dek', 1);
    const sealed = encrypt({ dek, purpose: 'dek-credentials', aad, plaintext: 'hello' });
    expect(() =>
      decrypt({ dek, purpose: 'dek-credentials', aad, sealed: sealed.subarray(0, 10) }),
    ).toThrow(CryptoError);
  });

  it('detects unsupported envelope version byte', () => {
    const dek = generateDek('vault:test/dek', 1);
    const sealed = encrypt({ dek, purpose: 'dek-credentials', aad, plaintext: 'x' });
    sealed[0] = 0xff;
    expect(() => decrypt({ dek, purpose: 'dek-credentials', aad, sealed })).toThrow(CryptoError);
  });

  it('AAD construction rejects unsafe identity chars', () => {
    expect(() => buildAad({ domain: 'qa_memory_answer', identity: ['no spaces'], rotationVersion: 1 })).toThrow();
    expect(() => buildAad({ domain: 'qa_memory_answer', identity: [], rotationVersion: 1 })).toThrow();
  });

  it('subkeys are deterministic for same inputs', () => {
    const dek = generateDek('vault:test/dek', 1);
    const k1 = deriveSubkey(dek, 'dek-personal');
    const k2 = deriveSubkey(dek, 'dek-personal');
    expect(k1.equals(k2)).toBe(true);
  });
});
