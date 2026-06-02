// BasePlatformAdapter — shared defaults so each platform implementation focuses
// on selectors and flows, not plumbing. Provides:
//   - capability declaration boilerplate,
//   - an apply-stream guard that converts a detected challenge into the correct
//     ApplyEvent for the run mode (Mode A → human-required pause; Mode B → skip),
//   - a fill helper that redacts values at the event boundary.
//
// Concrete adapters override the browser-driving methods. This class itself is
// browser-free and unit-testable.
//
// Reference: docs/architecture/06-automation-engine.md §3, §7, §8.

import type {
  AdapterCaps,
  AdapterContext,
  ApplicationPlan,
  ApplyEligibility,
  DiscoveredJob,
  JobDetail,
  PlatformAdapter,
  PlatformKey,
  ProfileSnapshot,
  ProfileChange,
  SearchFilters,
  SessionState,
} from './contract.js';
import { type ApplyEvent, Events, type AnswerSource } from './events.js';
import { type DetectionResult } from './safety/captcha.js';
import { redactValue } from './redaction.js';

export abstract class BasePlatformAdapter implements PlatformAdapter {
  abstract readonly key: PlatformKey;
  abstract readonly version: string;
  abstract readonly capabilities: AdapterCaps;

  // ----- Browser-driving methods: concrete adapters must implement. -----
  abstract ensureSession(ctx: AdapterContext): Promise<SessionState>;
  abstract refreshSession(ctx: AdapterContext): Promise<SessionState>;
  abstract search(ctx: AdapterContext, filters: SearchFilters): AsyncIterable<DiscoveredJob>;
  abstract parseListing(ctx: AdapterContext, raw: unknown): DiscoveredJob;
  abstract parseJob(ctx: AdapterContext, jobUrl: string): Promise<JobDetail>;
  abstract canApply(ctx: AdapterContext, job: JobDetail): Promise<ApplyEligibility>;
  abstract apply(ctx: AdapterContext, job: JobDetail, plan: ApplicationPlan): AsyncIterable<ApplyEvent>;

  // ----- Shared, browser-free helpers usable by every adapter. -----

  /**
   * Map a detected challenge + run mode to the correct terminal ApplyEvent.
   * Mode A pauses for human takeover (`human-required`); Mode B also emits
   * `human-required` but the worker will mark the application skipped. We never
   * solve. Returns null when no challenge is present.
   */
  protected challengeToEvent(detection: DetectionResult): ApplyEvent | null {
    if (detection.kind === 'none') return null;
    if (detection.kind === 'captcha') {
      return Events.captchaDetected(detection.signal, detection.provider);
    }
    const reasonMap: Record<string, 'otp' | 'phone' | 'email' | 'security'> = {
      otp: 'otp',
      phone: 'phone',
      email: 'email',
      security: 'security',
    };
    const reason = reasonMap[detection.kind] ?? 'security';
    return Events.humanRequired(reason);
  }

  /** Build a redacted `field.filled` event from a raw value. */
  protected emitFilled(field: string, rawValue: string, source: AnswerSource): ApplyEvent {
    return Events.fieldFilled(field, redactValue(rawValue), source);
  }

  /** Default no-op profile read (adapters with the capability override). */
  reviewProfile?(ctx: AdapterContext): Promise<ProfileSnapshot>;
  applyProfileChange?(ctx: AdapterContext, change: ProfileChange): Promise<void>;
  uploadResume?(ctx: AdapterContext, file: Uint8Array, name: string): Promise<{ platformResumeId: string }>;
}

/** Default capability set (everything off) for adapters to spread-and-override. */
export const NO_CAPS: AdapterCaps = {
  quickApply: false,
  multiStep: false,
  profileEdit: false,
  resumeUpload: false,
  profileRead: false,
  proposalBased: false,
};
