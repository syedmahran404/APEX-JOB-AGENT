// PII redaction policy applied by all Pino loggers.
//
// Reference: docs/architecture/04-backend-design.md §8 + Phase 8 §11.
// Two layers:
//   1. Pino's `redact` paths (deny-list of well-known keys).
//   2. A wildcard scrubber that strips any object key ending in `_enc`.

export const REDACTED = '[REDACTED]';

/** Pino-compatible redact paths. */
export const REDACT_PATHS: ReadonlyArray<string> = [
  // Auth and credentials.
  '*.password',
  '*.passwordHash',
  '*.password_hash',
  '*.secret',
  '*.secrets',
  '*.token',
  '*.tokens',
  '*.apiKey',
  '*.api_key',
  '*.authorization',
  '*.authorizationHeader',
  'authorization',
  'authorization-header',
  // Cipher columns.
  '*.cipher',
  '*.cipher_aad',
  '*.dek',
  '*.dataKey',
  '*.data_key',
  '*.dataKeyWrapped',
  '*.data_key_wrapped',
  '*.kek',
  '*.vaultToken',
  '*.vault_token',
  // PII.
  '*.phone',
  '*.phoneE164',
  '*.phone_e164',
  '*.dob',
  '*.dateOfBirth',
  '*.date_of_birth',
  '*.address',
  '*.addressLine1',
  '*.address_line_1',
  '*.ssn',
  '*.aadhaar',
  // Cookie + session.
  '*.cookie',
  '*.cookies',
  '*.sessionId',
  '*.session_id',
  // Webhook secrets.
  '*.webhookSecret',
  '*.webhook_secret',
];

/** Recursively replace any object key matching `_enc$`, `_wrapped$`, `Enc$`, or `Wrapped$`. */
export function scrubEnvelopedFields(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(scrubEnvelopedFields);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (/(?:_enc|_wrapped|Enc|Wrapped)$/.test(k)) continue; // strip
    out[k] = scrubEnvelopedFields(v);
  }
  return out;
}
