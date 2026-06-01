// AES-256-GCM seal / open. Stored format: `nonce || ciphertext+tag`.
// AAD is reconstructed by the caller (never stored). Subkeys are derived from
// the per-user DEK via HKDF (see hkdf.ts).

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { type Dek, deriveSubkey, type SubkeyPurpose } from './hkdf.js';
import { type AadFields, buildAad } from './aad.js';
import { CryptoError } from './errors.js';

const NONCE_BYTES = 12; // recommended for GCM
const TAG_BYTES = 16;
const VERSION_BYTE = 0x01; // first byte of stored buffer; bump on format change

export interface EncryptInput {
  dek: Dek;
  purpose: SubkeyPurpose;
  aad: AadFields;
  plaintext: Buffer | string;
  /** Optional per-row salt for HKDF; default empty. */
  extraSalt?: Buffer;
}

export interface DecryptInput {
  dek: Dek;
  purpose: SubkeyPurpose;
  aad: AadFields;
  sealed: Sealed;
  extraSalt?: Buffer;
}

export type Sealed = Buffer;

/** Encrypt → returns `Buffer( version || nonce || ct || tag )`. */
export function encrypt(input: EncryptInput): Sealed {
  const subkey = deriveSubkey(input.dek, input.purpose, input.extraSalt);
  const aad = buildAad(input.aad);
  try {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', subkey, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad, { plaintextLength: Buffer.byteLength(toBuf(input.plaintext)) });
    const ct = Buffer.concat([cipher.update(toBuf(input.plaintext)), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([Buffer.from([VERSION_BYTE]), nonce, ct, tag]);
  } finally {
    // Wipe subkey from memory.
    subkey.fill(0);
  }
}

/** Decrypt sealed buffer; throws CryptoError on auth failure. */
export function decrypt(input: DecryptInput): Buffer {
  const sealed = input.sealed;
  if (sealed.length < 1 + NONCE_BYTES + TAG_BYTES) {
    throw new CryptoError('invalid_input', 'Sealed buffer too short');
  }
  const version = sealed[0];
  if (version !== VERSION_BYTE) {
    throw new CryptoError('unsupported_version', `Unsupported envelope version: ${String(version)}`);
  }
  const nonce = sealed.subarray(1, 1 + NONCE_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const ct = sealed.subarray(1 + NONCE_BYTES, sealed.length - TAG_BYTES);

  const subkey = deriveSubkey(input.dek, input.purpose, input.extraSalt);
  const aad = buildAad(input.aad);
  try {
    const decipher = createDecipheriv('aes-256-gcm', subkey, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad, { plaintextLength: ct.length });
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(ct), decipher.final()]);
    return out;
  } catch {
    // Avoid distinguishing auth failure from internal errors via timing. We
    // throw a single CryptoError after a constant compare with the tag's bytes.
    timingSafeEqual(tag, tag);
    throw new CryptoError('auth_fail', 'Authentication failed (tag mismatch or wrong DEK/AAD)');
  } finally {
    subkey.fill(0);
  }
}

function toBuf(v: Buffer | string): Buffer {
  return typeof v === 'string' ? Buffer.from(v, 'utf8') : v;
}
