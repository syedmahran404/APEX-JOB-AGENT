// Adapter-specific error taxonomy. All extend ApexError so the API gateway's
// envelope serializer handles them uniformly. Adapters throw these from
// flow functions; the engine maps them to ApplyEvent outcomes.

import { ApexError, type ApexErrorOptions } from '@apex/shared-errors';

abstract class AdapterError extends ApexError {
  protected constructor(opts: ApexErrorOptions) {
    super(opts);
  }
}

export class SelectorDriftError extends AdapterError {
  public readonly selector: string;
  public readonly platformKey: string;
  public readonly adapterVersion: string;
  constructor(input: { selector: string; platformKey: string; adapterVersion: string; cause?: unknown }) {
    super({
      code: 'dependency_unavailable',
      status: 502,
      message: `Selector resolution failed on ${input.platformKey} (${input.selector})`,
      details: {
        kind: 'selector_drift',
        selector: input.selector,
        platformKey: input.platformKey,
        adapterVersion: input.adapterVersion,
      },
      cause: input.cause,
    });
    this.selector = input.selector;
    this.platformKey = input.platformKey;
    this.adapterVersion = input.adapterVersion;
    Object.setPrototypeOf(this, SelectorDriftError.prototype);
  }
}

export class ReconPendingError extends AdapterError {
  public readonly platformKey: string;
  constructor(platformKey: string, hint: string) {
    super({
      code: 'precondition_failed',
      status: 412,
      message: `Adapter ${platformKey} requires platform reconnaissance: ${hint}`,
      details: { kind: 'recon_pending', platformKey },
    });
    this.platformKey = platformKey;
    Object.setPrototypeOf(this, ReconPendingError.prototype);
  }
}

export class HumanRequiredError extends AdapterError {
  public readonly reason: 'captcha' | 'otp' | 'phone' | 'email' | 'security';
  constructor(reason: HumanRequiredError['reason'], detail?: string) {
    super({
      code: 'precondition_failed',
      status: 412,
      message: `Human action required: ${reason}${detail ? ` (${detail})` : ''}`,
      details: { kind: 'human_required', reason, detail },
    });
    this.reason = reason;
    Object.setPrototypeOf(this, HumanRequiredError.prototype);
  }
}

export class PlatformRateLimitError extends AdapterError {
  public readonly waitMs: number;
  constructor(platformKey: string, waitMs: number) {
    super({
      code: 'rate_limited',
      status: 429,
      message: `${platformKey} platform-side rate limit hit; wait ${waitMs.toString()}ms`,
      details: { kind: 'platform_rate_limit', platformKey, waitMs },
    });
    this.waitMs = waitMs;
    Object.setPrototypeOf(this, PlatformRateLimitError.prototype);
  }
}

export class SessionExpiredError extends AdapterError {
  public readonly platformKey: string;
  constructor(platformKey: string) {
    super({
      code: 'unauthenticated',
      status: 401,
      message: `${platformKey} session expired; re-login required`,
      details: { kind: 'session_expired', platformKey },
    });
    this.platformKey = platformKey;
    Object.setPrototypeOf(this, SessionExpiredError.prototype);
  }
}

export class AccountBlockedError extends AdapterError {
  public readonly platformKey: string;
  constructor(platformKey: string, reason: string) {
    super({
      code: 'forbidden',
      status: 403,
      message: `${platformKey} account is blocked or restricted: ${reason}`,
      details: { kind: 'account_blocked', platformKey, reason },
    });
    this.platformKey = platformKey;
    Object.setPrototypeOf(this, AccountBlockedError.prototype);
  }
}

export class MemoryPressureError extends AdapterError {
  public readonly platformKey: string;
  public readonly rssMb: number;
  constructor(platformKey: string, rssMb: number) {
    super({
      code: 'dependency_unavailable',
      status: 503,
      message: `Worker memory pressure (${rssMb.toString()} MB)`,
      details: { kind: 'memory_pressure', platformKey, rssMb },
    });
    this.platformKey = platformKey;
    this.rssMb = rssMb;
    Object.setPrototypeOf(this, MemoryPressureError.prototype);
  }
}

export class CancellationError extends AdapterError {
  constructor(reason = 'cancelled') {
    super({
      code: 'precondition_failed',
      status: 499,
      message: `Operation cancelled: ${reason}`,
      details: { kind: 'cancellation', reason },
    });
    Object.setPrototypeOf(this, CancellationError.prototype);
  }
}
