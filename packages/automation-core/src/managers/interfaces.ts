// Manager interfaces — the BaseAutomationEngine depends on these abstractions,
// not on concrete implementations. This makes the engine unit-testable with
// in-memory fakes and lets the worker swap implementations per environment.

import type { BrowserContext, Browser, Page } from 'playwright';
import type {
  Application,
  ApplicationStatus,
  Job,
  JobRun,
  PlatformAccount,
  PlatformPermission,
  PlatformSession,
  RunStage,
  StageStatus,
  RemoteKind,
  FreshnessTier,
} from '@apex/db';
import type { Domain } from '@apex/shared-types';
import type { ApplyEvent, RunEvent } from '@apex/shared-events';
import type { PlatformAdapter, PlatformKey, AdapterContext, AdapterCaps } from '../types/adapter.js';
import type { DiscoveredJob, JobDetail, ApplicationPlan, SubmitResult } from '../types/discovery.js';

// =============================================================================
// BrowserManager — owns the browser pool + per-(user, platform) contexts.
// =============================================================================

export interface BrowserAcquisition {
  /** The Playwright BrowserContext. The engine creates pages from it. */
  readonly context: BrowserContext;
  /** Stable id useful for logging. */
  readonly contextKey: string;
  /** Was this acquisition restored from persisted storage state, or is it cold? */
  readonly restored: boolean;
  /** Release the context back to the pool. Called from a `finally` block by the engine. */
  release(): Promise<void>;
}

export interface BrowserManager {
  /** Returns the underlying Browser, launching it lazily. */
  getBrowser(family?: 'chromium' | 'firefox' | 'webkit'): Promise<Browser>;
  /**
   * Acquire a context keyed by (userId, platformKey). If a warm context
   * exists under TTL, it is returned. Otherwise a fresh one is created
   * (with a restored storageState if available).
   */
  acquire(opts: {
    userId: string;
    platformKey: PlatformKey;
    storageStatePath?: string;
    fingerprintProfile?: BrowserFingerprintProfile;
  }): Promise<BrowserAcquisition>;
  /** Number of currently active contexts. */
  activeCount(): number;
  /** Shutdown — closes all contexts then the browser. */
  shutdown(): Promise<void>;
}

/** Per-user device profile passed into context creation. */
export interface BrowserFingerprintProfile {
  readonly userAgent: string;
  readonly viewport: { width: number; height: number };
  readonly timezoneId: string;
  readonly locale: string;
  readonly platform: 'Windows' | 'macOS' | 'Linux';
  readonly hardwareConcurrency: number;
  readonly deviceMemoryGb: number;
  readonly colorScheme: 'light' | 'dark';
}

// =============================================================================
// SessionManager — persists per-(user, platform) Playwright storage state.
// =============================================================================

export interface SessionManager {
  /** Restore the latest fresh session into a new BrowserContext, if any. */
  restoreLatest(accountId: string): Promise<{ uri: string; expiresAt: Date | null } | null>;
  /** Persist the current storageState back to object storage and DB. */
  persist(accountId: string, context: BrowserContext, opts?: { ttlMin?: number }): Promise<PlatformSession>;
  /** Mark a session stale (forces re-login on next acquire). */
  markStale(accountId: string): Promise<void>;
}

// =============================================================================
// PlatformManager — adapter registry + capability lookup.
// =============================================================================

export interface PlatformManager {
  register(adapter: PlatformAdapter): void;
  get(key: PlatformKey): PlatformAdapter;
  has(key: PlatformKey): boolean;
  list(): ReadonlyArray<{ key: PlatformKey; version: string; capabilities: AdapterCaps }>;
  /**
   * Resolve a platform-DB id (UUID) → adapter. The engine uses this when
   * a stage carries `platformId` (UUID) and we need the adapter object.
   */
  resolveById(platformId: string): Promise<PlatformAdapter>;
}

// =============================================================================
// StateManager — single writer to run/stage/application status fields.
// =============================================================================

export interface StateManager {
  /** Plan the run: persist stages in canonical order. Idempotent. */
  planRun(runId: string): Promise<{ run: JobRun; stages: ReadonlyArray<RunStage> }>;
  /** Transition a run to running (records started_at). */
  startRun(runId: string, fence: bigint, replica: string): Promise<JobRun>;
  /** Transition a run to a terminal status. */
  finishRun(
    runId: string,
    fence: bigint,
    status: 'done' | 'failed' | 'stopped',
    reason?: string,
  ): Promise<JobRun>;
  /** Read the current control flag (run/pause/stop) without locking. */
  readControl(runId: string): Promise<'run' | 'pause' | 'stop'>;

  /** Stage transitions. */
  startStage(stageId: string): Promise<RunStage>;
  startApplyingStage(stageId: string): Promise<RunStage>;
  finishStage(stageId: string, status: Extract<StageStatus, 'done' | 'skipped' | 'failed'>, reason?: string): Promise<RunStage>;

  /** Counters. */
  incrementStage(stageId: string, delta: { applied?: number; skipped?: number; failed?: number }): Promise<void>;

  /** Application transitions. */
  createApplication(input: {
    runId: string;
    stageId: string;
    userId: string;
    tenantId: string;
    jobId: string;
    platformId: string;
    aiScore: number | null;
    resumeVersionId: string | null;
    freshness: FreshnessTier | null;
    adapterVersion: string;
    wasDryRun: boolean;
    initialStatus: ApplicationStatus;
  }): Promise<Application>;
  setApplicationStatus(
    applicationId: string,
    status: ApplicationStatus,
    extra?: { reason?: string | null; externalApplicationId?: string | null; submittedAt?: Date | null; outcomeAt?: Date | null },
  ): Promise<Application>;
}

// =============================================================================
// RecoveryManager — retry policies + circuit breaker per platform.
// =============================================================================

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** A predicate. Returning false means "do not retry". */
  isRetryable(err: unknown): boolean;
}

export interface RecoveryManager {
  /**
   * Run `fn` with retry. The engine uses this for transient operations
   * (network blips, stale element). Permanent errors (ReconPendingError,
   * AccountBlockedError, HumanRequiredError) bypass retry.
   */
  withRetry<T>(name: string, fn: () => Promise<T>, policy?: Partial<RetryPolicy>): Promise<T>;
  /** Open the circuit for `platformKey` for `cooldownMs`. The engine queries this before dispatch. */
  trip(platformKey: PlatformKey, cooldownMs: number, reason: string): void;
  /** True when the platform-level circuit is currently tripped. */
  isTripped(platformKey: PlatformKey): boolean;
  /** Read all currently tripped platforms (for the operations dashboard). */
  trippedPlatforms(): ReadonlyArray<{ platformKey: PlatformKey; until: Date; reason: string }>;
}

// =============================================================================
// CaptchaDetectionManager
// =============================================================================

export type HumanRequiredKind = 'captcha' | 'otp' | 'phone' | 'email' | 'security' | 'none';

export interface CaptchaDetectionManager {
  /** Inspect a Page synchronously (DOM heuristics + URL heuristics). */
  detect(page: Page): Promise<HumanRequiredKind>;
}

// =============================================================================
// NotificationManager
// =============================================================================

export interface NotificationManager {
  /** User-visible notification (in-app + future email/push channels). */
  notify(input: {
    userId: string;
    tenantId: string;
    kind: string;
    title: string;
    body: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

// =============================================================================
// JobCollectionManager — aggregates discovered jobs from an adapter stream.
// =============================================================================

export interface JobCollectionManager {
  collect(opts: {
    adapter: PlatformAdapter;
    ctx: AdapterContext;
    filters: Domain.SearchFilters;
    /** Stop after this many candidates are emitted to the filter stage. */
    cap: number;
  }): Promise<ReadonlyArray<DiscoveredJob>>;
}

// =============================================================================
// JobFilteringManager — eligibility filters (already-applied, dedupe, threshold).
// =============================================================================

export interface JobFilteringManager {
  filter(input: {
    userId: string;
    tenantId: string;
    platformId: string;
    candidates: ReadonlyArray<DiscoveredJob>;
    /** Minimum AI score for inclusion. */
    thresholdScore: number;
    /** Drop jobs whose freshness is `stale`. */
    rejectStale: boolean;
  }): Promise<{ kept: ReadonlyArray<DiscoveredJob>; rejected: ReadonlyArray<{ job: DiscoveredJob; reason: string }> }>;
}

// =============================================================================
// JobPriorityManager — sorts a kept set by freshness then score.
// =============================================================================

export interface JobPriorityManager {
  prioritize(jobs: ReadonlyArray<DiscoveredJob & { aiScore?: number }>): ReadonlyArray<DiscoveredJob & { aiScore?: number }>;
}

// =============================================================================
// ApplicationExecutionManager — drives one application end-to-end.
// =============================================================================

export interface ApplicationExecutionManager {
  execute(input: {
    adapter: PlatformAdapter;
    ctx: AdapterContext;
    job: JobDetail;
    plan: ApplicationPlan;
  }): Promise<SubmitResult>;
}

// =============================================================================
// ScreenshotManager — capture + redact + upload to object storage.
// =============================================================================

export interface ScreenshotManager {
  capture(input: {
    page: Page;
    userId: string;
    tenantId: string;
    applicationId?: string | null;
    runId?: string | null;
    platformId?: string | null;
    label: string;
    /** Optional list of CSS selectors to blur before save (sensitive fields). */
    sensitiveSelectors?: ReadonlyArray<string>;
  }): Promise<{ uri: string; redacted: boolean }>;
}

// =============================================================================
// AuditManager — wrapper around AuditRepository.
// =============================================================================

export interface AuditManager {
  record(input: {
    tenantId: string;
    userId: string;
    actorKind: 'system' | 'automation_bot' | 'user';
    action: string;
    targetKind?: string;
    targetId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

// =============================================================================
// QueueManager — BullMQ producer/consumer wrapper. Worker-only concern.
// =============================================================================

export interface QueueManager {
  enqueueRun(runId: string, opts?: { delayMs?: number }): Promise<void>;
  shutdown(): Promise<void>;
}

// =============================================================================
// EventDispatcher — fans events out to outbox + Redis Pub/Sub.
// =============================================================================

export interface EventDispatcher {
  publishRunEvent(event: RunEvent, ctx: { runId: string; userId: string; tenantId: string }): Promise<void>;
  publishApplyEvent(event: ApplyEvent, ctx: { applicationId: string; userId: string; tenantId: string }): Promise<void>;
}

// =============================================================================
// PacingManager — token-bucket per (platform, user) and per-platform global.
// =============================================================================

export interface PacingManager {
  acquire(input: { platformKey: PlatformKey; userId: string; action: 'navigate' | 'click' | 'type' | 'scroll' | 'submit' | 'idle' }): Promise<void>;
  shutdown(): Promise<void>;
}

// =============================================================================
// AccountResolver — surfaces (platform_account, permission, session) to the engine.
// =============================================================================

export interface AccountSnapshot {
  readonly account: PlatformAccount;
  readonly permission: PlatformPermission;
  readonly latestSession: PlatformSession | null;
}

export interface AccountResolver {
  /** Returns account+permission+session, or null if user has no account on platform. */
  resolve(userId: string, platformId: string): Promise<AccountSnapshot | null>;
}

// =============================================================================
// JobScorer — pluggable AI scorer. In Phase 2 we ship a deterministic
// stand-in (keyword overlap) that the AI engine (Phase 3) replaces.
// =============================================================================

export interface JobScorer {
  scoreBatch(input: {
    userId: string;
    tenantId: string;
    profile: import('../types/adapter.js').AdapterProfileSlice;
    jobs: ReadonlyArray<DiscoveredJob>;
  }): Promise<ReadonlyArray<{ externalId: string; score: number; reasoning: string }>>;
}

// =============================================================================
// JobUpserter — discovery results → @apex/db. Wraps JobRepository so the
// engine doesn't import the repo directly.
// =============================================================================

export interface JobUpserter {
  upsertMany(input: {
    tenantId: string;
    platformId: string;
    discovered: ReadonlyArray<DiscoveredJob>;
  }): Promise<ReadonlyArray<Job>>;
}
