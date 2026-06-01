// Serialize ApexError → wire envelope. The envelope shape is also the contract
// returned by the API gateway's error filter; the web SDK parses it.

import { type ApexError, isApexError, InternalError, type ErrorCode, ValidationError } from './errors.js';

export interface ErrorEnvelope {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    traceId?: string;
    details?: Record<string, unknown>;
    issues?: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string; code?: string }>;
  };
}

/** Convert any thrown value into an ErrorEnvelope. Unknown errors become InternalError. */
export function toEnvelope(e: unknown, traceId?: string): { status: number; envelope: ErrorEnvelope } {
  const apex = isApexError(e) ? e : new InternalError('Internal server error', e);
  const baseEnvelope: ErrorEnvelope = {
    ok: false,
    error: {
      code: apex.code,
      message: apex.message,
    },
  };
  const tid = traceId ?? apex.traceId;
  if (tid) baseEnvelope.error.traceId = tid;
  if (apex.details) baseEnvelope.error.details = apex.details;
  if (apex instanceof ValidationError) baseEnvelope.error.issues = apex.issues;
  return { status: apex.status, envelope: baseEnvelope };
}

/** Best-effort: extract a code from any thrown value (for log fields). */
export function codeOf(e: unknown): ErrorCode | 'unknown' {
  return isApexError(e) ? e.code : 'unknown';
}

/** Re-export type for downstream consumers. */
export type { ApexError } from './errors.js';
