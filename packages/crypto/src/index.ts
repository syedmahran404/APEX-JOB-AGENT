// @apex/crypto — envelope encryption primitives.
//
// AES-256-GCM with a 96-bit nonce, ciphertext stored as `nonce || ct`.
// Per-purpose subkeys derived from the per-user DEK via HKDF-SHA-256.
// AAD binds ciphertext to its row identity (table + identifier columns).
//
// Reference: docs/architecture/08-security-architecture.md §3.

export {
  generateDek,
  deriveSubkey,
  type Dek,
  type SubkeyPurpose,
  SUBKEY_PURPOSES,
} from './hkdf.js';

export { buildAad, parseAadDomain, type AadDomain, type AadFields } from './aad.js';

export {
  encrypt,
  decrypt,
  type EncryptInput,
  type DecryptInput,
  type Sealed,
} from './envelope.js';

export { zeroize, withZeroizedBuffer } from './zeroize.js';

export { CryptoError } from './errors.js';
