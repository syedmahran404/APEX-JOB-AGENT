// The PlatformAdapter contract — the single interface every platform implements.
//
// Reference: docs/architecture/06-automation-engine.md §3.
//
// This module is intentionally browser-agnostic at the type level: `AdapterContext`
// carries opaque handles (`page`, `context`) typed as `unknown` here so that
// @apex/automation-core stays free of a hard Playwright dependency. The worker
// (apps/automation-worker) supplies the concrete Playwright types when it wires
// adapters up. Pure logic (parsers, classifiers, pacing) needs none of it and is
// fully unit-testable.

import type { Domain } from '@apex/shared-types';
import type { ApplyEvent } from './events.js';

export type PlatformKey = Domain.PlatformKey;

/** What an adapter can do. The orchestrator/AI consult this before forming intent. */
export interface AdapterCaps {
  /** Single-screen "quick"/"easy" apply flow available. */
  quickApply: boolean;
  /** Multi-screen apply flow available. */
  multiStep: boolean;
  /** Adapter can edit the on-platform profile (gated by permission). */
  profileEdit: boolean;
  /** Adapter can upload a resume file. */
  resumeUpload: boolean;
  /** Adapter can read back the on-platform profile snapshot. */
  profileRead: boolean;
  /** "Apply" semantics are a proposal (e.g. Upwork) rather than a form submit. */
  proposalBased: boolean;
}

/** Anti-detection intensity. FAST is for offline fixture tests only. */
export type AntiDetectionProfile = 'STRICT_DEFAULT' | 'BALANCED' | 'FAST';

/** Remote-work filter classes. */
export type RemoteKind = 'remote' | 'hybrid' | 'onsite' | 'any';

/** Search filters supplied by a run. */
export interface SearchFilters {
  query: string;
  location?: string | undefined;
  remoteKind?: RemoteKind | undefined;
  salaryMin?: number | undefined;
  /** Posted-within window in hours; listings older than this are discarded. */
  postedWithinHours?: number | undefined;
}

/** A job as seen in a search result list (pre-detail). */
export interface DiscoveredJob {
  /** Adapter-stable identifier on the platform (e.g. LinkedIn job id). */
  externalId: string;
  platformKey: PlatformKey;
  title: string;
  company: string;
  location?: string | undefined;
  url: string;
  /** Resolved absolute posting time (UTC). Null when the platform gives nothing usable. */
  postedAt: Date | null;
  /** True when `postedAt` was inferred (e.g. "recently") rather than reported. */
  postedAtUncertain: boolean;
  remoteKind?: RemoteKind | undefined;
}

/** A fully-parsed job detail page. */
export interface JobDetail extends DiscoveredJob {
  description: string;
  salaryText?: string | undefined;
  applyKind: ApplyKind;
}

/** How an application can proceed on a given job. */
export type ApplyKind = 'quick' | 'multi_step' | 'external_redirect' | 'closed' | 'already_applied';

export interface ApplyEligibility {
  kind: ApplyKind;
  /** When external_redirect, the detected ATS host (if recognized). */
  externalAtsHost?: string | undefined;
  reason?: string | undefined;
}

/** The plan the orchestrator/AI hand to `apply()`. */
export interface ApplicationPlan {
  applicationId: string;
  resumeVersionId: string;
  /** Whether AI-tailored answers are permitted for this application. */
  allowAiAnswers: boolean;
  /** Mode A pauses for human takeover; Mode B skips on human-required. */
  mode: 'assisted' | 'autonomous';
}

export interface SessionState {
  status: 'authenticated' | 'expired' | 'blocked' | 'unknown';
  /** Opaque storage-state location (e.g. S3 URI) when persisted. */
  storageUri?: string | undefined;
  checkedAt: Date;
}

export interface ProfileSnapshot {
  takenAt: Date;
  fields: Record<string, string>;
}

export interface ProfileChange {
  field: string;
  value: string;
  suggestionId: string;
}

/**
 * The per-task context the worker hands to an adapter. Browser handles are typed
 * as `unknown` to keep this package browser-free; the worker narrows them.
 */
export interface AdapterContext {
  readonly userId: string;
  readonly platformKey: PlatformKey;
  readonly profile: AntiDetectionProfile;
  /** Playwright Page — opaque here. */
  readonly page: unknown;
  /** Playwright BrowserContext — opaque here. */
  readonly browserContext: unknown;
  readonly logger: AdapterLogger;
  readonly clock: Clock;
  /** Deterministic randomness source (seedable for tests). */
  readonly random: Random;
  /** Cooperative cancellation. */
  readonly cancellation: CancellationSignal;
}

export interface AdapterLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface Clock {
  now(): Date;
}

export interface Random {
  /** Uniform float in [0, 1). */
  next(): number;
}

export interface CancellationSignal {
  readonly cancelled: boolean;
  throwIfCancelled(): void;
}

/** The contract every platform adapter implements. */
export interface PlatformAdapter {
  readonly key: PlatformKey;
  /** Semver; bumped whenever selectors or flows change (adapter-version pinning). */
  readonly version: string;
  readonly capabilities: AdapterCaps;

  ensureSession(ctx: AdapterContext): Promise<SessionState>;
  refreshSession(ctx: AdapterContext): Promise<SessionState>;

  search(ctx: AdapterContext, filters: SearchFilters): AsyncIterable<DiscoveredJob>;
  parseListing(ctx: AdapterContext, raw: unknown): DiscoveredJob;
  parseJob(ctx: AdapterContext, jobUrl: string): Promise<JobDetail>;

  canApply(ctx: AdapterContext, job: JobDetail): Promise<ApplyEligibility>;
  apply(ctx: AdapterContext, job: JobDetail, plan: ApplicationPlan): AsyncIterable<ApplyEvent>;

  reviewProfile?(ctx: AdapterContext): Promise<ProfileSnapshot>;
  applyProfileChange?(ctx: AdapterContext, change: ProfileChange): Promise<void>;
  uploadResume?(ctx: AdapterContext, file: Uint8Array, name: string): Promise<{ platformResumeId: string }>;
}
