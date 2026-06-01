// Discovery types — what the adapter emits while crawling and parsing.
//
// `DiscoveredJob` is the lightweight shape produced by `search()` —
// enough to upsert `jobs` and run scoring without opening the detail page.
//
// `JobDetail` is the heavier shape produced by `parseJob()` — full
// description + structured fields. Only emitted when the engine decides to
// pursue an application.

import { z } from 'zod';
import { Domain } from '@apex/shared-types';

const Uuid = z.string().uuid();

export const DiscoveredJob = z.object({
  /** Stable id from the platform (LinkedIn jobId, Naukri "n_id", etc.). */
  externalId: z.string().min(1),
  url: z.string().url(),
  title: z.string().min(1),
  company: z.string().nullable(),
  location: z.string().nullable(),
  remoteKind: Domain.RemoteKind.nullable(),
  /** Best-effort posting time. Null when only "recently" was visible. */
  postedAt: z.coerce.date().nullable(),
  /** True when posting time was inferred from a relative phrase. */
  postedAtUncertain: z.boolean(),
  /** Tier computed at discovery time using the orchestrator's clock. */
  freshness: Domain.FreshnessTier.nullable(),
  /** Optional snippet shown on the listing card; the full description comes from parseJob. */
  snippet: z.string().nullable(),
  applicants: z.number().int().nonnegative().nullable(),
  salaryMin: z.coerce.bigint().nullable(),
  salaryMax: z.coerce.bigint().nullable(),
  currency: z.string().length(3).nullable(),
  isQuickApply: z.boolean().nullable(),
  /** Stable canonical key for cross-platform dedupe (audit fix C1). */
  canonicalKey: z.string(),
  /** Skills extracted from the listing card (best effort). */
  requiredSkills: z.array(z.string()).default([]),
});
export type DiscoveredJob = z.infer<typeof DiscoveredJob>;

export const JobDetail = DiscoveredJob.extend({
  /** Full description in markdown (after best-effort HTML→MD conversion). */
  descriptionMd: z.string().nullable(),
  /** Raw extraction payload — kept for forensic replay. */
  raw: z.record(z.string(), z.unknown()).default({}),
});
export type JobDetail = z.infer<typeof JobDetail>;

/** Result of `canApply()` — drives orchestrator decision branching. */
export const ApplyEligibility = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('quick') }),
  z.object({ kind: z.literal('multi_step') }),
  z.object({
    kind: z.literal('external_redirect'),
    /** ATS provider when detectable (workday/greenhouse/lever/ashby/smartrecruiters/unknown). */
    ats: z.string(),
  }),
  z.object({ kind: z.literal('closed') }),
  z.object({ kind: z.literal('already_applied') }),
  z.object({ kind: z.literal('unsupported'), reason: z.string() }),
]);
export type ApplyEligibility = z.infer<typeof ApplyEligibility>;

/** Application execution plan handed to `apply()`. */
export const ApplicationPlan = z.object({
  applicationId: Uuid,
  /** Resume version id chosen by the orchestrator (or null for "no resume"). */
  resumeVersionId: Uuid.nullable(),
  /** Optional cover letter id (generated artifact stored in object storage). */
  coverLetterId: Uuid.nullable(),
  /** When true, fill the form but do NOT submit — Phase 4 dry-run mode. */
  dryRun: z.boolean(),
  /** Mode-A: pause on human-required; Mode-B: skip and continue. */
  autonomous: z.boolean(),
  /** Worker pacing profile to honor for this application. */
  pacingProfile: z.enum(['STRICT_DEFAULT', 'BALANCED', 'FAST']),
  /** Maximum total time (ms) before we bail out and mark failed. */
  maxDurationMs: z.number().int().positive().default(10 * 60_000),
  /** Idempotency key — already persisted on the application row. */
  idempotencyKey: z.string().min(1),
});
export type ApplicationPlan = z.infer<typeof ApplicationPlan>;

/** Final outcome returned alongside the event stream. */
export const SubmitResult = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('submitted'),
    externalApplicationId: z.string().nullable(),
    confirmation: z.enum(['http200+dom', 'dom-only', 'redirect-success']),
    submittedAt: z.coerce.date(),
  }),
  z.object({ kind: z.literal('skipped'), reason: z.string() }),
  z.object({ kind: z.literal('failed'), reason: z.string(), recoverable: z.boolean() }),
]);
export type SubmitResult = z.infer<typeof SubmitResult>;
