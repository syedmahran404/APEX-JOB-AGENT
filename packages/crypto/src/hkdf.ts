// HKDF-SHA-256 subkey derivation. We never use the raw DEK directly for AEAD;
// we derive a per-purpose subkey so that compromise of one purpose doesn't
// leak others.

import { createHash, hkdfSync, randomBytes } from 'node:crypto';
import { CryptoError } from './errors.js';

export const DEK_BYTES = 32;
export const SUBKEY_BYTES = 32;

export interface Dek {
  /** Raw 256-bit key material. Treat as sensitive; pass to zeroize() when done. */
  key: Buffer;
  /** Stable identifier for which Vault key wrapped this DEK. */
  vaultKeyId: string;
  /** Monotonically increasing version; used by the rotation reaper. */
  version: number;
}

/** Subkey purposes — must match column purposes documented in Phase 8 §3.1. */
export const SUBKEY_PURPOSES = [
  'dek-credentials',
  'dek-personal',
  'dek-totp',
  'dek-sessionstate',
  'dek-qa',
  'dek-cookie-secrets',
] as const;
export type SubkeyPurpose = (typeof SUBKEY_PURPOSES)[number];

/** Generate a fresh DEK using a CSPRNG. */
export function generateDek(vaultKeyId: string, version = 1): Dek {
  return { key: randomBytes(DEK_BYTES), vaultKeyId, version };
}

/**
 * Derive a deterministic per-purpose subkey from a DEK.
 *
 * Uses HKDF-SHA-256 with the purpose label as `info`. A second salt parameter
 * is allowed for additional domain separation (e.g., per-user salt held in DB).
 */
export function deriveSubkey(dek: Dek, purpose: SubkeyPurpose, extraSalt: Buffer = Buffer.alloc(0)): Buffer {
  if (!SUBKEY_PURPOSES.includes(purpose)) {
    throw new CryptoError('invalid_input', `Unknown subkey purpose: ${String(purpose)}`);
  }
  // HKDF: extract(salt) then expand(info) — we use empty salt (extract step is
  // a no-op-equivalent) and put domain separation in `info`. extraSalt is
  // appended to info for per-row separation.
  const info = Buffer.concat([
    Buffer.from(`apex/${purpose}/v${dek.version}`),
    extraSalt,
  ]);
  // hkdfSync returns ArrayBuffer — coerce to Buffer for ergonomic use.
  const out = hkdfSync('sha256', dek.key, Buffer.alloc(0), info, SUBKEY_BYTES);
  return Buffer.from(out);
}

/** Stable hash of a string for log fields where we want correlation but not the value. */
export function shortHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url').slice(0, 12);
}
