// AAD construction. The ciphertext is bound to its row identity so that a
// blob copied to a different row fails authentication.
//
// Format (UTF-8):
//   apex/v1/<domain>/<field-1>/<field-2>/.../<rotation-version>
//
// The trailing `rotation-version` lets us re-encrypt under a new DEK without
// breaking older AAD bindings (the version is included in the AAD itself).

import { CryptoError } from './errors.js';

export type AadDomain =
  | 'platform_credentials'
  | 'personal_info'
  | 'totp_secret'
  | 'qa_memory_answer'
  | 'session_storage_state'
  | 'webhook_secret'
  | 'cookie_csrf_secret';

export interface AadFields {
  domain: AadDomain;
  /** Identity columns that uniquely address the row. Order matters. */
  identity: ReadonlyArray<string>;
  /** DEK rotation version; bumped on re-encrypt under a new key. */
  rotationVersion: number;
}

const SAFE_RE = /^[A-Za-z0-9._:-]+$/;

export function buildAad(fields: AadFields): Buffer {
  if (fields.identity.length === 0) {
    throw new CryptoError('invalid_input', 'AAD requires at least one identity field');
  }
  const safeIds = fields.identity.map((id) => {
    if (typeof id !== 'string' || id.length === 0) {
      throw new CryptoError('invalid_input', 'AAD identity must be non-empty strings');
    }
    if (!SAFE_RE.test(id)) {
      throw new CryptoError('invalid_input', `AAD identity contains illegal chars: ${id}`);
    }
    return id;
  });
  const text = ['apex', 'v1', fields.domain, ...safeIds, String(fields.rotationVersion)].join('/');
  return Buffer.from(text, 'utf8');
}

export function parseAadDomain(aad: Buffer): AadDomain | null {
  const text = aad.toString('utf8');
  const parts = text.split('/');
  if (parts.length < 4 || parts[0] !== 'apex' || parts[1] !== 'v1') return null;
  const domain = parts[2] as AadDomain;
  return domain;
}
