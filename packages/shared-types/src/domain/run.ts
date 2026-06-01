// Run / stage domain shapes.

import { z } from 'zod';
import { PlatformId, TenantId, Uuid, UserId } from './ids.js';

export const RunMode = z.enum(['single', 'multi']);
export type RunMode = z.infer<typeof RunMode>;

export const RunStatus = z.enum([
  'pending',
  'planning',
  'running',
  'paused',
  'stopped',
  'done',
  'failed',
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const RunControl = z.enum(['run', 'pause', 'stop']);
export type RunControl = z.infer<typeof RunControl>;

export const StageStatus = z.enum([
  'pending',
  'discovering',
  'applying',
  'done',
  'skipped',
  'failed',
]);
export type StageStatus = z.infer<typeof StageStatus>;

/** Reasons a stage may be skipped. Stable strings — clients display these. */
export const StageSkipReason = z.enum([
  'no_account',
  'platform_disabled',
  'permission_denied',
  'quota_reached',
  'user_stop',
  'recon_pending',
  'rate_limited_platform',
  'session_blocked',
]);
export type StageSkipReason = z.infer<typeof StageSkipReason>;

export const JobRun = z.object({
  id: Uuid,
  tenantId: TenantId,
  userId: UserId,
  mode: RunMode,
  status: RunStatus,
  control: RunControl,
  targetPerPlatform: z.number().int().positive(),
  thresholdScore: z.number().int().min(0).max(100),
  autonomous: z.boolean(),
  dryRun: z.boolean(),
  requestedPlatforms: z.array(PlatformId),
  startedAt: z.coerce.date().nullable(),
  finishedAt: z.coerce.date().nullable(),
  idempotencyKey: z.string().min(1),
  config: z.record(z.string(), z.unknown()).default({}),
  leaseFence: z.coerce.bigint(),
  ownerReplica: z.string().nullable(),
});
export type JobRun = z.infer<typeof JobRun>;

export const RunStage = z.object({
  id: Uuid,
  tenantId: TenantId,
  runId: Uuid,
  platformId: PlatformId,
  ordinal: z.number().int().nonnegative(),
  status: StageStatus,
  target: z.number().int().positive(),
  appliedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  startedAt: z.coerce.date().nullable(),
  finishedAt: z.coerce.date().nullable(),
  reason: z.string().nullable(),
});
export type RunStage = z.infer<typeof RunStage>;

/** Inputs to start a new run. The API validates this before it touches the DB. */
export const StartRunInput = z.object({
  mode: RunMode,
  platformIds: z.array(PlatformId).min(1).max(8),
  targetPerPlatform: z.number().int().min(1).max(500).default(20),
  thresholdScore: z.number().int().min(0).max(100).default(70),
  autonomous: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});
export type StartRunInput = z.infer<typeof StartRunInput>;
