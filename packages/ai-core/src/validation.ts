// Structured-output validation + the retry/fallback decision logic. Every prompt
// that produces a decision returns JSON validated against a Zod schema before it
// may mutate state. On failure: one stricter retry, then the declared fallback
// ladder. This module is pure: it decides what to do; the gateway performs I/O.
//
// Reference: docs/architecture/07-ai-engine.md §5.

import type { ZodTypeAny, infer as ZodInfer } from 'zod';
import type { Tier } from './providers/types.js';
import type { PromptDef } from './prompts/registry.js';

export interface ParseSuccess<T> {
  ok: true;
  value: T;
}
export interface ParseFailure {
  ok: false;
  /** Compact, human-readable issues for the stricter retry message. */
  issues: string;
  raw: string;
}
export type ParseOutcome<T> = ParseSuccess<T> | ParseFailure;

/** Extract JSON from a model output that may be wrapped in prose/markdown fences. */
export function extractJson(raw: string): string {
  const trimmed = raw.trim();
  // Strip ```json ... ``` fences.
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fence?.[1]) return fence[1].trim();
  // Otherwise take the first balanced {...} or [...] block.
  const firstObj = trimmed.indexOf('{');
  const firstArr = trimmed.indexOf('[');
  const start = firstObj < 0 ? firstArr : firstArr < 0 ? firstObj : Math.min(firstObj, firstArr);
  if (start >= 0) {
    const lastObj = trimmed.lastIndexOf('}');
    const lastArr = trimmed.lastIndexOf(']');
    const end = Math.max(lastObj, lastArr);
    if (end > start) return trimmed.slice(start, end + 1);
  }
  return trimmed;
}

/** Parse + validate raw model output against a schema. */
export function validateOutput<S extends ZodTypeAny>(schema: S, raw: string): ParseOutcome<ZodInfer<S>> {
  let json: unknown;
  try {
    json = JSON.parse(extractJson(raw));
  } catch (err) {
    return { ok: false, issues: `Output was not valid JSON: ${(err as Error).message}`, raw };
  }
  const result = schema.safeParse(json);
  if (result.success) return { ok: true, value: result.data as ZodInfer<S> };
  const issues = result.error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return { ok: false, issues, raw };
}

/** Build the stricter retry system suffix from prior issues. */
export function stricterRetryMessage(issues: string): string {
  return `Your previous output failed to parse: ${issues}. Return JSON exactly matching the schema, with no prose or markdown fences.`;
}

export type AttemptPlan =
  | { action: 'retry-stricter'; tier: Tier; temperatureDelta: number }
  | { action: 'fallback'; tier: Tier }
  | { action: 'give-up' };

/**
 * Decide the next attempt after a validation failure.
 *  - attempt 0 failed → one stricter retry at the same tier, slightly cooler.
 *  - attempt 1 failed → walk the prompt's fallback ladder (by index).
 *  - ladder exhausted → give up (caller returns a typed low-confidence/human path).
 */
export function planNextAttempt(prompt: PromptDef, failedAttempt: number): AttemptPlan {
  if (failedAttempt === 0) {
    return { action: 'retry-stricter', tier: prompt.tier, temperatureDelta: -0.1 };
  }
  // After the stricter retry (attempt index 1), index into the fallback ladder.
  const ladderIndex = failedAttempt - 1;
  const step = prompt.fallback[ladderIndex];
  if (step) return { action: 'fallback', tier: step.tier };
  return { action: 'give-up' };
}

/** Clamp a temperature into the valid [0, 1] band after applying a delta. */
export function adjustTemperature(base: number, delta: number): number {
  return Math.max(0, Math.min(1, Number((base + delta).toFixed(2))));
}
