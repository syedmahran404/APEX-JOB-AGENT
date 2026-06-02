// Queue task payload schemas — the wire contract between the orchestrator
// (producer) and the automation-worker (consumer). Validated with Zod at both
// ends so a malformed job fails fast on the DLQ rather than mid-flow.
//
// Reference: docs/architecture/06-automation-engine.md §5, docs/architecture/04-backend-design.md §4.

import { z } from 'zod';

/** Anti-detection profile names (mirror of contract.AntiDetectionProfile). */
export const ProfileName = z.enum(['STRICT_DEFAULT', 'BALANCED', 'FAST']);

export const RemoteKindSchema = z.enum(['remote', 'hybrid', 'onsite', 'any']);

export const SearchFiltersSchema = z.object({
  query: z.string().min(1),
  location: z.string().optional(),
  remoteKind: RemoteKindSchema.optional(),
  salaryMin: z.number().int().nonnegative().optional(),
  postedWithinHours: z.number().int().positive().optional(),
});
export type SearchFiltersPayload = z.infer<typeof SearchFiltersSchema>;

/** Common envelope present on every automation task. */
const TaskBase = {
  /** Owning run. */
  runId: z.string().uuid(),
  /** Owning stage (one platform leg of a run). */
  stageId: z.string().uuid(),
  userId: z.string().uuid(),
  tenantId: z.string().uuid(),
  platformKey: z.string().min(1),
  profile: ProfileName.default('STRICT_DEFAULT'),
  /** Monotonic attempt counter the worker increments through retries. */
  attempt: z.number().int().nonnegative().default(0),
  /** When true, never submits — drives the flow but stops before final submit. */
  dryRun: z.boolean().default(false),
};

/** Discovery task: search a platform and emit discovered jobs. */
export const DiscoveryTask = z.object({
  ...TaskBase,
  kind: z.literal('discovery'),
  filters: SearchFiltersSchema,
  /** Idempotency key so a re-dispatched discovery does not double-insert. */
  idempotencyKey: z.string().min(1),
});
export type DiscoveryTask = z.infer<typeof DiscoveryTask>;

/** Apply task: apply to a single job. */
export const ApplyTask = z.object({
  ...TaskBase,
  kind: z.literal('apply'),
  applicationId: z.string().uuid(),
  jobExternalId: z.string().min(1),
  jobUrl: z.string().url(),
  resumeVersionId: z.string().uuid(),
  allowAiAnswers: z.boolean().default(true),
  mode: z.enum(['assisted', 'autonomous']).default('assisted'),
  /** Idempotency key — one successful submit per (user, job). */
  idempotencyKey: z.string().min(1),
});
export type ApplyTask = z.infer<typeof ApplyTask>;

/** Session-refresh task: re-validate / re-auth a platform context. */
export const SessionRefreshTask = z.object({
  ...TaskBase,
  kind: z.literal('session_refresh'),
  reason: z.enum(['idle-ttl', 'max-age', 'expired', 'blocked', 'unknown', 'scheduled']),
});
export type SessionRefreshTask = z.infer<typeof SessionRefreshTask>;

/** Schedule-fire task: scheduler → orchestrator, "start a recurring run now". */
export const ScheduleFireTask = z.object({
  kind: z.literal('schedule_fire'),
  scheduleId: z.string().uuid(),
  userId: z.string().uuid(),
  tenantId: z.string().uuid(),
  /** Saved search / run template to materialize into a run. */
  templateId: z.string().uuid(),
  firedAt: z.string().datetime(),
});
export type ScheduleFireTask = z.infer<typeof ScheduleFireTask>;

export const AutomationTask = z.discriminatedUnion('kind', [DiscoveryTask, ApplyTask, SessionRefreshTask]);
export type AutomationTask = z.infer<typeof AutomationTask>;

export function parseDiscoveryTask(raw: unknown): DiscoveryTask {
  return DiscoveryTask.parse(raw);
}
export function parseApplyTask(raw: unknown): ApplyTask {
  return ApplyTask.parse(raw);
}
export function parseSessionRefreshTask(raw: unknown): SessionRefreshTask {
  return SessionRefreshTask.parse(raw);
}
export function parseScheduleFireTask(raw: unknown): ScheduleFireTask {
  return ScheduleFireTask.parse(raw);
}
