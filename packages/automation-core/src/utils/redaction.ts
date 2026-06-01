// Redaction helpers for ApplyEvent emission. We never let raw plaintext PII
// into the event stream; adapters call `redactValue(field, value)` before
// emitting `field.filled`.
//
// The classifier is intentionally simple: pattern-driven on the field name
// (case-insensitive) and the value's shape. Anything ambiguous defaults to
// strict redaction.

const PII_FIELD_PATTERNS = [
  /password/i,
  /passcode/i,
  /^(secret|token|api[._-]?key)/i,
  /^(ssn|aadhaar|pan|nric)/i,
  /(phone|mobile|tel)/i,
  /(email|e[._-]?mail)/i,
  /(address|street|city|zip|postal)/i,
  /(dob|date.?of.?birth)/i,
  /(otp|one[._-]?time[._-]?code)/i,
  /(card|cvc|cvv|account[._-]?number)/i,
];

const SAFE_FIELD_PATTERNS = [
  /^name$/i,
  /^first[._-]?name$/i,
  /^last[._-]?name$/i,
  /^salary/i,
  /^expected[._-]?salary/i,
  /^notice[._-]?period/i,
  /^years?[._-]?of[._-]?experience/i,
  /^willing[._-]?to[._-]?relocate/i,
  /^current[._-]?title/i,
  /^current[._-]?company/i,
  /^location$/i,
];

/**
 * Returns a value safe to emit in events. Either the original value (when
 * the field is recognised as non-PII) or a length-preserving redaction.
 *
 * Length preservation helps debugging without leaking content: the
 * redaction's character count matches the input.
 */
export function redactValue(fieldName: string, value: string): string {
  if (value.length === 0) return '';
  if (matches(SAFE_FIELD_PATTERNS, fieldName) && !matches(PII_FIELD_PATTERNS, fieldName)) {
    return truncate(value, 256);
  }
  if (matches(PII_FIELD_PATTERNS, fieldName)) {
    return mask(value);
  }
  // Free-form text — partially mask so debugging shape is possible.
  return mask(value);
}

function matches(patterns: ReadonlyArray<RegExp>, name: string): boolean {
  for (const p of patterns) if (p.test(name)) return true;
  return false;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** Mask: keep first 1 and last 1 chars; replace the middle with `*` × len. */
function mask(s: string): string {
  if (s.length <= 2) return '*'.repeat(s.length);
  return `${s[0] ?? ''}${'*'.repeat(Math.min(s.length - 2, 30))}${s[s.length - 1] ?? ''}`;
}

/** Are any of the predicates considered "always sensitive"? Used by ScreenshotManager. */
export function isSensitiveField(fieldName: string): boolean {
  return matches(PII_FIELD_PATTERNS, fieldName);
}
