// Typed error hierarchy. The only place in the codebase allowed to subclass
// the built-in Error. Enforced by the apex/error-class-from-shared-errors rule.
//
// Reference: docs/architecture/04-backend-design.md §3.6.

export type ErrorCode =
  | 'validation_error'
  | 'unauthenticated'
  | 'mfa_required'
  | 'forbidden'
  | 'permission_required'
  | 'not_found'
  | 'conflict'
  | 'idempotency_mismatch'
  | 'precondition_failed'
  | 'rate_limited'
  | 'dependency_unavailable'
  | 'internal_error';

export interface ApexErrorOptions {
  /** Stable code surfaced to clients. */
  code: ErrorCode;
  /** Human-readable, safe to display. */
  message: string;
  /** HTTP status code; the API gateway maps to this. */
  status: number;
  /** Optional structured details (must already be redacted of PII by the throw site). */
  details?: Record<string, unknown>;
  /** Optional underlying cause; not serialized to clients. */
  cause?: unknown;
  /** Optional W3C trace id; populated by the API gateway error filter when available. */
  traceId?: string;
}

/**
 * Base class for every error in the system. Carries `code`, `status`, and
 * optional `details` / `traceId`. Subclasses fix `code` and `status` to
 * specific values; thrown sites only provide the message and optional details.
 */
export abstract class ApexError extends Error {
  public readonly code: ErrorCode;
  public readonly status: number;
  public readonly details: Record<string, unknown> | undefined;
  public readonly traceId: string | undefined;

  protected constructor(opts: ApexErrorOptions) {
    super(opts.message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = new.target.name;
    this.code = opts.code;
    this.status = opts.status;
    this.details = opts.details;
    this.traceId = opts.traceId;
    // Preserve prototype chain across transpile targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  withTraceId(traceId: string): this {
    (this as { traceId: string | undefined }).traceId = traceId;
    return this;
  }
}

export interface ValidationIssue {
  path: ReadonlyArray<string | number>;
  message: string;
  code?: string;
}

export class ValidationError extends ApexError {
  public readonly issues: ReadonlyArray<ValidationIssue>;

  constructor(message: string, issues: ReadonlyArray<ValidationIssue>, details?: Record<string, unknown>) {
    super({ code: 'validation_error', status: 400, message, details });
    this.issues = issues;
  }
}

export class UnauthenticatedError extends ApexError {
  constructor(message = 'Authentication required') {
    super({ code: 'unauthenticated', status: 401, message });
  }
}

export class MfaRequiredError extends ApexError {
  constructor(message = 'A fresh MFA proof is required for this action') {
    super({ code: 'mfa_required', status: 401, message });
  }
}

export class ForbiddenError extends ApexError {
  constructor(message = 'Forbidden', details?: Record<string, unknown>) {
    super({ code: 'forbidden', status: 403, message, details });
  }
}

export class PermissionRequiredError extends ApexError {
  public readonly permission: string;
  public readonly scope: Record<string, unknown> | undefined;

  constructor(permission: string, scope?: Record<string, unknown>) {
    super({
      code: 'permission_required',
      status: 403,
      message: `Missing permission: ${permission}`,
      details: { permission, scope },
    });
    this.permission = permission;
    this.scope = scope;
  }
}

export class NotFoundError extends ApexError {
  constructor(message = 'Not found', details?: Record<string, unknown>) {
    super({ code: 'not_found', status: 404, message, details });
  }
}

export class ConflictError extends ApexError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({ code: 'conflict', status: 409, message, details });
  }
}

export class IdempotencyMismatchError extends ApexError {
  constructor(key: string) {
    super({
      code: 'idempotency_mismatch',
      status: 409,
      message: 'Idempotency key was previously used with a different request body.',
      details: { key },
    });
  }
}

export class PreconditionFailedError extends ApexError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({ code: 'precondition_failed', status: 412, message, details });
  }
}

export interface RateLimitedDetails extends Record<string, unknown> {
  retryAfterSec: number;
  limit: number;
  remaining: number;
}

export class RateLimitedError extends ApexError {
  public readonly retryAfterSec: number;

  constructor(retryAfterSec: number, details: Omit<RateLimitedDetails, 'retryAfterSec'>) {
    super({
      code: 'rate_limited',
      status: 429,
      message: 'Rate limit exceeded',
      details: { retryAfterSec, ...details },
    });
    this.retryAfterSec = retryAfterSec;
  }
}

export class DependencyError extends ApexError {
  public readonly dependency: string;

  constructor(dependency: string, message: string, cause?: unknown) {
    super({
      code: 'dependency_unavailable',
      status: 502,
      message,
      details: { dependency },
      cause,
    });
    this.dependency = dependency;
  }
}

export class InternalError extends ApexError {
  constructor(message = 'Internal server error', cause?: unknown) {
    super({ code: 'internal_error', status: 500, message, cause });
  }
}

/** Type guard: was this error produced by us? */
export function isApexError(e: unknown): e is ApexError {
  return e instanceof ApexError;
}
