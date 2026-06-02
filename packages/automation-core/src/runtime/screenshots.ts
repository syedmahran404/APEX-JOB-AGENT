// Screenshot system — metadata model + storage-key derivation + capture-point
// taxonomy. The actual pixel capture is performed by the BrowserDriver; the
// upload (with sensitive-region blur) is the worker's reporting layer. This
// module owns the pure metadata/key logic and is fully unit-testable.
//
// Reference: docs/architecture/06-automation-engine.md §7 (screenshot events),
//            §13 (browser isolation / artifact redaction).

/** Why a screenshot was taken. Drives retention + visibility in the dashboard. */
export type ScreenshotReason = 'login' | 'submission' | 'failure' | 'exception' | 'captcha' | 'step';

export interface ScreenshotMetadata {
  reason: ScreenshotReason;
  runId: string;
  applicationId?: string | undefined;
  platformKey: string;
  /** A short label, e.g. step name. */
  label: string;
  /** ISO timestamp the capture was taken. */
  capturedAt: string;
  /** S3 object key where the (blurred) image is stored. */
  storageKey: string;
  /** CSS selectors whose regions must be blurred before persistence. */
  sensitiveSelectors: string[];
  /** Content hash placeholder (set by the uploader after blur). */
  sha256?: string | undefined;
}

export interface ScreenshotCaptureInput {
  reason: ScreenshotReason;
  runId: string;
  userId: string;
  platformKey: string;
  label: string;
  applicationId?: string | undefined;
  capturedAt: Date;
  sensitiveSelectors?: string[] | undefined;
  /** Monotonic per-run sequence so keys never collide within a run. */
  seq: number;
}

/** Default sensitive selectors blurred on every platform unless overridden. */
export const DEFAULT_SENSITIVE_SELECTORS: string[] = [
  'input[type="password"]',
  'input[autocomplete="one-time-code"]',
  'input[name="pin"]',
  'input[name="otp"]',
];

/**
 * Deterministic S3 object key for a screenshot. Partitioned by user/run so
 * lifecycle rules and per-user export/delete are simple. The key carries no
 * secret. Example:
 *   screenshots/{userId}/{runId}/{seq}-{reason}-{platform}.png
 */
export function screenshotStorageKey(input: {
  userId: string;
  runId: string;
  seq: number;
  reason: ScreenshotReason;
  platformKey: string;
}): string {
  const seqStr = String(input.seq).padStart(4, '0');
  const safeLabel = `${input.reason}-${input.platformKey}`.replace(/[^a-z0-9-]/gi, '_').toLowerCase();
  return `screenshots/${input.userId}/${input.runId}/${seqStr}-${safeLabel}.png`;
}

/** Build the persisted metadata record for a capture. */
export function buildScreenshotMetadata(input: ScreenshotCaptureInput): ScreenshotMetadata {
  const storageKey = screenshotStorageKey({
    userId: input.userId,
    runId: input.runId,
    seq: input.seq,
    reason: input.reason,
    platformKey: input.platformKey,
  });
  return {
    reason: input.reason,
    runId: input.runId,
    applicationId: input.applicationId,
    platformKey: input.platformKey,
    label: input.label,
    capturedAt: input.capturedAt.toISOString(),
    storageKey,
    sensitiveSelectors: input.sensitiveSelectors ?? DEFAULT_SENSITIVE_SELECTORS,
  };
}

/** Retention class (days) by reason — failures/exceptions kept longer for forensics. */
export function retentionDays(reason: ScreenshotReason): number {
  switch (reason) {
    case 'submission':
      return 365; // proof of application
    case 'failure':
    case 'exception':
    case 'captcha':
      return 90; // forensics
    case 'login':
      return 30;
    case 'step':
      return 14;
  }
}
