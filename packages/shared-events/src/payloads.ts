import { z } from 'zod';

const Uuid = z.string().uuid();

// =============================================================================
// RUN-SCOPED EVENTS
// =============================================================================

export const RunEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('run.planned'), runId: Uuid, stages: z.array(z.object({ platformKey: z.string(), ordinal: z.number().int() })) }),
  z.object({ kind: z.literal('run.started'), runId: Uuid }),
  z.object({ kind: z.literal('run.paused'), runId: Uuid }),
  z.object({ kind: z.literal('run.resumed'), runId: Uuid }),
  z.object({ kind: z.literal('run.stopped'), runId: Uuid }),
  z.object({ kind: z.literal('run.done'), runId: Uuid, applied: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(), failed: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('run.failed'), runId: Uuid, reason: z.string() }),
  z.object({ kind: z.literal('stage.started'), runId: Uuid, stageId: Uuid, platformKey: z.string() }),
  z.object({ kind: z.literal('stage.discovery.started'), runId: Uuid, stageId: Uuid }),
  z.object({ kind: z.literal('stage.discovery.complete'), runId: Uuid, stageId: Uuid, found: z.number().int().nonnegative(), eligible: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('stage.applying'), runId: Uuid, stageId: Uuid }),
  z.object({ kind: z.literal('stage.done'), runId: Uuid, stageId: Uuid, applied: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('stage.skipped'), runId: Uuid, stageId: Uuid, reason: z.string() }),
  z.object({ kind: z.literal('stage.failed'), runId: Uuid, stageId: Uuid, reason: z.string() }),
]);
export type RunEvent = z.infer<typeof RunEvent>;

// =============================================================================
// APPLICATION-SCOPED EVENTS — ApplyEvent taxonomy emitted by adapters
// =============================================================================

export const AnswerSource = z.enum(['frequent_answer', 'qa_memory', 'ai_generated', 'user_intervention']);
export type AnswerSource = z.infer<typeof AnswerSource>;

export const FieldKind = z.enum(['text', 'textarea', 'select', 'radio', 'checkbox', 'file', 'date', 'number']);
export type FieldKind = z.infer<typeof FieldKind>;

export const HumanRequiredReason = z.enum(['captcha', 'otp', 'phone', 'email', 'security']);
export type HumanRequiredReason = z.infer<typeof HumanRequiredReason>;

export const ApplyEvent = z.discriminatedUnion('kind', [
  // Lifecycle
  z.object({ kind: z.literal('queued'), applicationId: Uuid, jobId: Uuid, platformKey: z.string() }),
  z.object({ kind: z.literal('opened'), applicationId: Uuid, url: z.string().url() }),
  z.object({ kind: z.literal('step.started'), applicationId: Uuid, step: z.string() }),

  // Field interaction
  z.object({
    kind: z.literal('field.filled'),
    applicationId: Uuid,
    field: z.string(),
    valueRedacted: z.string(),
    source: AnswerSource,
  }),

  // Question handling
  z.object({
    kind: z.literal('question.encountered'),
    applicationId: Uuid,
    questionRaw: z.string(),
    fieldKind: FieldKind,
    expectsAi: z.boolean(),
    options: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal('question.answered'),
    applicationId: Uuid,
    questionId: Uuid,
    source: AnswerSource,
    aiDecisionId: z.coerce.bigint().optional(),
  }),

  // Captures
  z.object({ kind: z.literal('screenshot'), applicationId: Uuid, uri: z.string(), label: z.string(), redacted: z.boolean() }),
  z.object({ kind: z.literal('dom-snapshot'), applicationId: Uuid, uri: z.string(), label: z.string() }),

  // Detection
  z.object({ kind: z.literal('captcha.detected'), applicationId: Uuid, provider: z.string().optional(), locator: z.string() }),
  z.object({ kind: z.literal('human-required'), applicationId: Uuid, reason: HumanRequiredReason, details: z.string().optional() }),
  z.object({ kind: z.literal('rate-limited'), applicationId: Uuid, waitMs: z.number().int().nonnegative() }),

  // Outcomes
  z.object({
    kind: z.literal('submitted'),
    applicationId: Uuid,
    externalApplicationId: z.string().optional(),
    confirmation: z.enum(['http200+dom', 'dom-only', 'redirect-success']),
  }),
  z.object({ kind: z.literal('skipped'), applicationId: Uuid, reason: z.string() }),
  z.object({ kind: z.literal('step.failed'), applicationId: Uuid, step: z.string(), reason: z.string(), recoverable: z.boolean() }),

  // Status updates (post-submission, e.g. from email ingest in later phases).
  z.object({
    kind: z.literal('status_changed'),
    applicationId: Uuid,
    from: z.string(),
    to: z.string(),
    source: z.enum(['adapter', 'email_ingest', 'user_override']),
  }),
]);
export type ApplyEvent = z.infer<typeof ApplyEvent>;

/** Discriminator helper for narrowing inside switch statements. */
export type ApplyEventKind = ApplyEvent['kind'];
