// Value redaction at the ApplyEvent boundary (§7). The raw value never leaves
// the adapter; events carry only the redacted form. Pure & deterministic.

/** Mask an email as `a***@d***.com`-style. */
function redactEmail(value: string): string {
  const at = value.indexOf('@');
  if (at <= 0) return maskGeneric(value);
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const tld = dot >= 0 ? domain.slice(dot) : '';
  const domainName = dot >= 0 ? domain.slice(0, dot) : domain;
  return `${local[0] ?? ''}***@${domainName[0] ?? ''}***${tld}`;
}

/** Keep last 4 digits of a phone-like value; mask the rest, preserving shape. */
function redactPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 4) return maskGeneric(value);
  const last4 = digits.slice(-4);
  const prefix = value.startsWith('+') ? '+' : '';
  return `${prefix}**-***-***-${last4}`;
}

function maskGeneric(value: string): string {
  if (value.length <= 2) return '*'.repeat(value.length);
  return `${value[0] ?? ''}${'*'.repeat(Math.max(1, value.length - 2))}${value[value.length - 1] ?? ''}`;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^[+]?[\d\s().-]{7,}$/;

/**
 * Redact a free-form field value for inclusion in an ApplyEvent. Detects emails
 * and phone numbers; otherwise applies a generic first/last-char mask. Empty and
 * obviously non-sensitive short tokens (e.g. "Yes"/"No") are passed through.
 */
export function redactValue(value: string): string {
  const v = value.trim();
  if (v === '') return '';
  if (EMAIL_RE.test(v)) return redactEmail(v);
  if (PHONE_RE.test(v) && /\d/.test(v)) return redactPhone(v);
  // Short categorical answers are not sensitive.
  if (v.length <= 4 && /^[a-z0-9 ]+$/i.test(v)) return v;
  return maskGeneric(v);
}
