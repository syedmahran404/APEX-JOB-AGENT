// Application domain shapes.

import { z } from 'zod';
import { PlatformId, TenantId, Uuid, UserId } from './ids.js';
import { FreshnessTier } from './job.js';

export const ApplicationStatus = z.enum([
  // Active lifecycle
  'queued',
  'submitting',
  'submitted',
  'viewed',
  'shortlisted',
  'rejected',
  'interview_scheduled',
  'offer',
  'withdrawn',
  'closed_no_response',
  // Skipped (recoverable / explicit decisions)
  'skipped_human_required',
  'skipped_low_score',
  'skipped_stale',
  'skipped_external_ats',
  'skipped_recon_pending',
  'skipped_duplicate',
  // Failed (post-mortem; usually retryable on next run)
  'failed_selector_drift',
  'failed_platform_error',
  'duplicate',
]);
export type ApplicationStatus = z.infer<typeof ApplicationStatus>;

/** Statuses that count as a successful submission for analytics. */
export const SUBMITTED_STATUSES = new Set<ApplicationStatus>([
  'submitted',
  'viewed',
  'shortlisted',
  'rejected',
  'interview_scheduled',
  'offer',
  'withdrawn',
  'closed_no_response',
]);

/** Statuses where the partial unique index permits a retry (per audit fix A1). */
export const RETRYABLE_TERMINAL_STATUSES = new Set<ApplicationStatus>([
  'failed_selector_drift',
  'failed_platform_error',
  'skipped_human_required',
  'skipped_low_score',
  'skipped_stale',
  'skipped_external_ats',
  'skipped_recon_pending',
  'skipped_duplicate',
  'duplicate',
]);

export const FieldKind = z.enum([
  'text',
  'textarea',
  'select',
  'radio',
  'checkbox',
  'file',
  'date',
  'number',
]);
export type FieldKind = z.infer<typeof FieldKind>;

export const AnswerSource = z.enum([
  'frequent_answer',
  'qa_memory',
  'ai_generated',
  'user_intervention',
]);
export type AnswerSource = z.infer<typeof AnswerSource>;

export const Application = z.object({
  id: Uuid,
  tenantId: TenantId,
  userId: UserId,
  runId: Uuid.nullable(),
  stageId: Uuid.nullable(),
  jobId: Uuid,
  platformId: PlatformId,
  status: ApplicationStatus,
  aiScore: z.number().int().min(0).max(100).nullable(),
  resumeVersionId: Uuid.nullable(),
  coverLetterId: Uuid.nullable(),
  freshnessAtApply: FreshnessTier.nullable(),
  submittedAt: z.coerce.date().nullable(),
  outcomeAt: z.coerce.date().nullable(),
  reason: z.string().nullable(),
  externalApplicationId: z.string().nullable(),
  idempotencyKey: z.string().min(1),
  adapterVersion: z.string().min(1),
  wasDryRun: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Application = z.infer<typeof Application>;

export const ApplicationQuestion = z.object({
  id: Uuid,
  applicationId: Uuid,
  questionRaw: z.string(),
  questionNorm: z.string(),
  fieldKind: FieldKind,
  answer: z.string().nullable(),
  source: AnswerSource,
  aiDecisionId: z.coerce.bigint().nullable(),
});
export type ApplicationQuestion = z.infer<typeof ApplicationQuestion>;
