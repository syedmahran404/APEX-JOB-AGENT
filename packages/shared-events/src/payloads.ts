import { z } from 'zod';

export const RunEvent = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('planned'),
    runId: z.string().uuid(),
    stages: z.array(z.object({ platformKey: z.string(), ordinal: z.number().int() })),
  }),
  z.object({ kind: z.literal('stage.started'), runId: z.string().uuid(), stageId: z.string().uuid() }),
  z.object({ kind: z.literal('stage.done'), runId: z.string().uuid(), stageId: z.string().uuid() }),
  z.object({ kind: z.literal('paused'), runId: z.string().uuid() }),
  z.object({ kind: z.literal('resumed'), runId: z.string().uuid() }),
  z.object({ kind: z.literal('stopped'), runId: z.string().uuid() }),
  z.object({ kind: z.literal('failed'), runId: z.string().uuid(), reason: z.string() }),
]);
export type RunEvent = z.infer<typeof RunEvent>;

export const ApplicationEvent = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('queued'),
    applicationId: z.string().uuid(),
    jobId: z.string().uuid(),
    platformKey: z.string(),
  }),
  z.object({ kind: z.literal('opened'), applicationId: z.string().uuid() }),
  z.object({
    kind: z.literal('filled'),
    applicationId: z.string().uuid(),
    field: z.string(),
    valueRedacted: z.string(),
  }),
  z.object({
    kind: z.literal('question_answered'),
    applicationId: z.string().uuid(),
    questionId: z.string().uuid(),
    source: z.enum(['frequent_answer', 'qa_memory', 'ai_generated', 'user_intervention']),
  }),
  z.object({ kind: z.literal('submitted'), applicationId: z.string().uuid() }),
  z.object({
    kind: z.literal('status_changed'),
    applicationId: z.string().uuid(),
    from: z.string(),
    to: z.string(),
  }),
  z.object({
    kind: z.literal('captcha_detected'),
    applicationId: z.string().uuid(),
    provider: z.string().optional(),
  }),
  z.object({
    kind: z.literal('skipped'),
    applicationId: z.string().uuid(),
    reason: z.string(),
  }),
  z.object({
    kind: z.literal('failed'),
    applicationId: z.string().uuid(),
    reason: z.string(),
  }),
]);
export type ApplicationEvent = z.infer<typeof ApplicationEvent>;
