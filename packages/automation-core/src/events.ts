// ApplyEvent taxonomy — the ordered stream an adapter's `apply()` emits.
// The worker persists each event to `application_events` before the next step,
// giving real-time UX, forensics, and resumability.
//
// Reference: docs/architecture/06-automation-engine.md §7.

import { z } from 'zod';

/** Where an answer came from. Mirrors @apex/shared-events ApplicationEvent sources. */
export const AnswerSource = z.enum(['frequent_answer', 'qa_memory', 'ai_generated', 'user_intervention']);
export type AnswerSource = z.infer<typeof AnswerSource>;

export const FieldKind = z.enum(['text', 'number', 'select', 'radio', 'checkbox', 'file', 'date']);
export type FieldKind = z.infer<typeof FieldKind>;

/** Confirmation strength for a submission. */
export const SubmitConfirmation = z.enum(['http200+dom', 'dom-only', 'redirect-success']);
export type SubmitConfirmation = z.infer<typeof SubmitConfirmation>;

/** Why a human is required (Mode A pauses, Mode B skips). */
export const HumanRequiredReason = z.enum([
  'captcha',
  'otp',
  'phone',
  'email',
  'security',
  'policy:low-confidence',
]);
export type HumanRequiredReason = z.infer<typeof HumanRequiredReason>;

export const ApplyEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('step.started'), step: z.string(), ts: z.string() }),
  z.object({
    kind: z.literal('field.filled'),
    field: z.string(),
    /** Redacted form of the value, e.g. "+91-***-***-1234". Never the raw value. */
    valueRedacted: z.string(),
    source: AnswerSource,
  }),
  z.object({
    kind: z.literal('question.encountered'),
    question: z.string(),
    fieldKind: FieldKind,
    expectsAi: z.boolean(),
  }),
  z.object({
    kind: z.literal('question.answered'),
    questionId: z.string(),
    source: AnswerSource,
    aiDecisionId: z.string().optional(),
  }),
  z.object({ kind: z.literal('screenshot'), uri: z.string(), label: z.string() }),
  z.object({ kind: z.literal('captcha.detected'), provider: z.string().optional(), locator: z.string() }),
  z.object({ kind: z.literal('human-required'), reason: HumanRequiredReason, details: z.string().optional() }),
  z.object({
    kind: z.literal('submitted'),
    externalApplicationId: z.string().optional(),
    confirmation: SubmitConfirmation,
  }),
  z.object({ kind: z.literal('step.failed'), step: z.string(), reason: z.string(), recoverable: z.boolean() }),
  z.object({ kind: z.literal('rate-limited'), waitMs: z.number().int().nonnegative() }),
]);
export type ApplyEvent = z.infer<typeof ApplyEvent>;

/** Validate an unknown value as an ApplyEvent (defensive boundary parsing). */
export function parseApplyEvent(raw: unknown): ApplyEvent {
  return ApplyEvent.parse(raw);
}

/** Strongly-typed constructors so adapters never hand-build event objects. */
export const Events = {
  stepStarted(step: string, ts: string): ApplyEvent {
    return { kind: 'step.started', step, ts };
  },
  fieldFilled(field: string, valueRedacted: string, source: AnswerSource): ApplyEvent {
    return { kind: 'field.filled', field, valueRedacted, source };
  },
  questionEncountered(question: string, fieldKind: FieldKind, expectsAi: boolean): ApplyEvent {
    return { kind: 'question.encountered', question, fieldKind, expectsAi };
  },
  questionAnswered(questionId: string, source: AnswerSource, aiDecisionId?: string): ApplyEvent {
    return aiDecisionId === undefined
      ? { kind: 'question.answered', questionId, source }
      : { kind: 'question.answered', questionId, source, aiDecisionId };
  },
  screenshot(uri: string, label: string): ApplyEvent {
    return { kind: 'screenshot', uri, label };
  },
  captchaDetected(locator: string, provider?: string): ApplyEvent {
    return provider === undefined
      ? { kind: 'captcha.detected', locator }
      : { kind: 'captcha.detected', locator, provider };
  },
  humanRequired(reason: HumanRequiredReason, details?: string): ApplyEvent {
    return details === undefined
      ? { kind: 'human-required', reason }
      : { kind: 'human-required', reason, details };
  },
  submitted(confirmation: SubmitConfirmation, externalApplicationId?: string): ApplyEvent {
    return externalApplicationId === undefined
      ? { kind: 'submitted', confirmation }
      : { kind: 'submitted', confirmation, externalApplicationId };
  },
  stepFailed(step: string, reason: string, recoverable: boolean): ApplyEvent {
    return { kind: 'step.failed', step, reason, recoverable };
  },
  rateLimited(waitMs: number): ApplyEvent {
    return { kind: 'rate-limited', waitMs };
  },
} as const;

/**
 * True once the apply stream has reached a terminal event. The worker uses this
 * to know when to stop persisting and release the semaphore.
 */
export function isTerminalEvent(e: ApplyEvent): boolean {
  return e.kind === 'submitted' || (e.kind === 'step.failed' && !e.recoverable) || e.kind === 'human-required';
}
