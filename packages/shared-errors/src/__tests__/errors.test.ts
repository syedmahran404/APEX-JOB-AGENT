import { describe, expect, it } from 'vitest';
import {
  ValidationError,
  UnauthenticatedError,
  PermissionRequiredError,
  RateLimitedError,
  isApexError,
  toEnvelope,
} from '../index.js';

describe('ApexError hierarchy', () => {
  it('preserves code, status, message', () => {
    const e = new ValidationError('bad', [{ path: ['x'], message: 'required' }]);
    expect(e.code).toBe('validation_error');
    expect(e.status).toBe(400);
    expect(e.message).toBe('bad');
  });

  it('isApexError narrows', () => {
    const e: unknown = new UnauthenticatedError();
    expect(isApexError(e)).toBe(true);
    if (isApexError(e)) {
      expect(e.status).toBe(401);
    }
  });

  it('PermissionRequiredError carries permission + scope in details', () => {
    const e = new PermissionRequiredError('resume.edit.linkedin', { platform: 'linkedin' });
    expect(e.details).toMatchObject({ permission: 'resume.edit.linkedin', scope: { platform: 'linkedin' } });
  });

  it('RateLimitedError serializes retry-after', () => {
    const e = new RateLimitedError(30, { limit: 100, remaining: 0 });
    const { status, envelope } = toEnvelope(e, 'trace-1');
    expect(status).toBe(429);
    expect(envelope.error.code).toBe('rate_limited');
    expect(envelope.error.traceId).toBe('trace-1');
    expect(envelope.error.details).toMatchObject({ retryAfterSec: 30, limit: 100, remaining: 0 });
  });

  it('toEnvelope wraps unknown thrown values as internal_error', () => {
    const { status, envelope } = toEnvelope(new RangeError('whoops'));
    expect(status).toBe(500);
    expect(envelope.error.code).toBe('internal_error');
  });

  it('ValidationError surfaces issues in the envelope', () => {
    const e = new ValidationError('shape', [{ path: ['email'], message: 'must be email' }]);
    const { envelope } = toEnvelope(e);
    expect(envelope.error.issues).toHaveLength(1);
    expect(envelope.error.issues?.[0]?.path).toEqual(['email']);
  });
});
