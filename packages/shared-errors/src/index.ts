export {
  ApexError,
  ValidationError,
  UnauthenticatedError,
  MfaRequiredError,
  ForbiddenError,
  PermissionRequiredError,
  NotFoundError,
  ConflictError,
  IdempotencyMismatchError,
  PreconditionFailedError,
  RateLimitedError,
  DependencyError,
  InternalError,
  isApexError,
  type ErrorCode,
  type ApexErrorOptions,
  type ValidationIssue,
  type RateLimitedDetails,
} from './errors.js';

export { toEnvelope, codeOf, type ErrorEnvelope } from './serialize.js';
