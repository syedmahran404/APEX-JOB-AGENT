// PlatformAdapter contract + AdapterContext.
//
// An adapter is a stateless object describing a platform; the engine drives
// it via `apply()` and `search()`, passing in an `AdapterContext` that
// carries the live Playwright handles, the per-call event emitter, and
// pacing/cancellation hooks.

import type { Page, BrowserContext } from 'playwright';
import type { Logger } from '@apex/shared-logger';
import type { Domain, Events as EventsTopics } from '@apex/shared-types';
import type { ApplyEvent } from '@apex/shared-events';
import type { ApplicationPlan, DiscoveredJob, JobDetail, ApplyEligibility, SubmitResult } from './discovery.js';

/** Stable platform identifier — string union maintained in shared-types. */
export type PlatformKey = Domain.PlatformKey;

/**
 * Adapter capabilities. The engine consults these *before* invoking a flow,
 * so an unsupported call never reaches the adapter. Capabilities are static
 * (per-adapter, not per-account).
 */
export interface AdapterCaps {
  /** Adapter can detect and follow a single-click "Easy Apply" / "Quick Apply". */
  readonly quickApply: boolean;
  /** Adapter can drive multi-step apply forms. */
  readonly multiStep: boolean;
  /** Adapter can reach the platform's profile editor (gated by permission). */
  readonly profileEdit: boolean;
  /** Adapter can upload a resume to the platform. */
  readonly resumeUpload: boolean;
  /** Adapter has external-ATS detection wired in. */
  readonly atsDetection: boolean;
  /** Adapter has been verified against the live platform UI. */
  readonly verifiedAgainstLive: boolean;
}

/**
 * Per-call adapter context. Construction is the engine's responsibility;
 * adapters never instantiate Playwright primitives themselves.
 */
export interface AdapterContext {
  /** Active Playwright page. */
  readonly page: Page;
  /** Owning context (Playwright). */
  readonly browserContext: BrowserContext;
  /** Pre-bound logger with userId/runId/applicationId fields. */
  readonly logger: Logger;
  /** Tenant id for per-tenant scoping (audit fix A8). */
  readonly tenantId: string;
  /** User id (UUID). */
  readonly userId: string;
  /** Unique correlation id for the current run, when applicable. */
  readonly runId: string | null;
  /** Active application id when the call is scoped to a specific apply. */
  readonly applicationId: string | null;
  /** Adapter version that should be pinned on persisted rows (audit fix C5). */
  readonly adapterVersion: string;
  /** Topic builder for run-scoped event publication. */
  readonly topics: typeof EventsTopics;
  /** Cancellation signal — adapters MUST check this between atomic steps. */
  readonly cancellation: AbortSignal;
  /** Deterministic random source — used for human-like delays. */
  readonly random: () => number;
  /** Authoritative wall clock for the orchestrator. Adapters use this, not Date.now. */
  readonly now: () => Date;
  /**
   * Emit one ApplyEvent. The engine forwards to the outbox + Redis Pub/Sub.
   * Calls that fail to emit do not throw — the engine swallows transport errors.
   */
  readonly emit: (event: ApplyEvent) => void;
  /** Pacing helper — token-bucket aware sleep ("ask the bucket for permission, then wait"). */
  readonly pace: (action: PaceAction) => Promise<void>;
  /** Pre-loaded user knowledge (frequent_answers + qa_memory subset for this stage). */
  readonly knowledge: AdapterKnowledge;
}

/** Per-action pacing categories — the bucket weights vary by category. */
export type PaceAction = 'navigate' | 'click' | 'type' | 'scroll' | 'submit' | 'idle';

/** What the engine pre-loads for the adapter. */
export interface AdapterKnowledge {
  /** Map of normalized question → answer (locked frequent answers). */
  readonly frequentAnswers: ReadonlyMap<string, FrequentAnswer>;
  /** Profile slice safe to read (no DEK; PII is already decrypted). */
  readonly profile: AdapterProfileSlice;
}

export interface FrequentAnswer {
  readonly normalized: string;
  readonly answer: string;
  readonly category: string | null;
  readonly isLocked: boolean;
}

/**
 * Profile slice handed to adapters. Phase 2 ships a minimal subset; later
 * phases extend it with experience/education/skills bullets.
 */
export interface AdapterProfileSlice {
  readonly displayName: string;
  readonly headline: string | null;
  readonly summary: string | null;
  readonly currentTitle: string | null;
  readonly currentCompany: string | null;
  readonly totalExperienceMonths: number | null;
  readonly noticePeriodDays: number | null;
  readonly willingToRelocate: boolean | null;
  readonly preferredCurrency: string | null;
  readonly expectedSalaryMin: bigint | null;
  readonly expectedSalaryMax: bigint | null;
  readonly preferredLocations: ReadonlyArray<string>;
}

/** Search-side and apply-side contracts. */
export interface PlatformAdapter {
  readonly key: PlatformKey;
  readonly version: string;
  readonly capabilities: AdapterCaps;

  /** Make sure we are logged in. Idempotent. */
  ensureSession(ctx: AdapterContext): Promise<void>;

  /**
   * Stream discovered jobs. The engine consumes one at a time, scoring and
   * filtering as they arrive. The adapter MUST stop iterating when the
   * cancellation signal aborts.
   */
  search(ctx: AdapterContext, filters: import('@apex/shared-types').Domain.SearchFilters): AsyncIterable<DiscoveredJob>;

  /** Open a job page and parse its full detail. */
  parseJob(ctx: AdapterContext, jobUrl: string): Promise<JobDetail>;

  /** Determine the apply path before opening the form. */
  canApply(ctx: AdapterContext, job: JobDetail): Promise<ApplyEligibility>;

  /**
   * Run the apply flow. Emits ApplyEvent items and resolves with a
   * SubmitResult. Throws AdapterError on unrecoverable failures; the engine
   * maps those to ApplicationStatus + ApplyEvent("step.failed").
   */
  apply(
    ctx: AdapterContext,
    job: JobDetail,
    plan: ApplicationPlan,
  ): Promise<SubmitResult>;

  /** Optional: upload a resume to the platform. Capability-gated. */
  uploadResume?(
    ctx: AdapterContext,
    file: Buffer,
    fileName: string,
  ): Promise<{ platformResumeId: string }>;
}
