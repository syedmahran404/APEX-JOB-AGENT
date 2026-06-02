// Decision audit — every model call writes one ai_decisions row. The `inputs`
// field is REDACTED before write: a deny-list strips known PII keys; structural
// fields that make the decision reconstructible are kept. Pure; ai-service
// persists the produced record.
//
// Reference: docs/architecture/07-ai-engine.md §8; §15.3 (no PII in logs).

import type { Tier } from '../providers/types.js';
import type { PromptKey } from '../prompts/registry.js';
import type { GovernorAction } from '../governor/cost.js';

/** Keys whose values are PII and must be stripped from audited inputs. */
export const PII_DENY_KEYS = new Set([
  'email',
  'phone',
  'phonenumber',
  'address',
  'dob',
  'dateofbirth',
  'ssn',
  'nationalid',
  'passport',
  'fullname',
  'firstname',
  'lastname',
  'password',
  'token',
  'secret',
  'answer', // the chosen answer text lives in `output`, not `inputs`
  'answertext',
]);

/** Recursively redact PII keys from an arbitrary input object. */
export function redactInputs(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redactInputs);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PII_DENY_KEYS.has(k.toLowerCase())) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactInputs(v);
      }
    }
    return out;
  }
  return value;
}

export interface AiDecisionRecord {
  promptKey: PromptKey;
  promptVersion: number;
  tier: Tier;
  model: string;
  /** Scope this decision belongs to (e.g. application id, user id). */
  scopeKind: 'application' | 'user' | 'job' | 'resume';
  scopeId: string;
  userId: string;
  /** Redacted, reconstructible inputs. */
  inputs: unknown;
  /** The structured output (validated) or raw text on validation failure. */
  output: unknown;
  /** Present when both attempts failed validation. */
  validationError?: string | undefined;
  governorAction: GovernorAction;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** W3C trace id, when available. */
  traceId?: string | undefined;
  occurredAt: string;
}

export interface BuildDecisionInput {
  promptKey: PromptKey;
  promptVersion: number;
  tier: Tier;
  model: string;
  scopeKind: AiDecisionRecord['scopeKind'];
  scopeId: string;
  userId: string;
  rawInputs: unknown;
  output: unknown;
  governorAction: GovernorAction;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  validationError?: string | undefined;
  traceId?: string | undefined;
  now: Date;
}

/** Build the audited decision record with inputs redacted at construction. */
export function buildDecisionRecord(input: BuildDecisionInput): AiDecisionRecord {
  return {
    promptKey: input.promptKey,
    promptVersion: input.promptVersion,
    tier: input.tier,
    model: input.model,
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
    userId: input.userId,
    inputs: redactInputs(input.rawInputs),
    output: input.output,
    validationError: input.validationError,
    governorAction: input.governorAction,
    costUsd: input.costUsd,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    latencyMs: input.latencyMs,
    traceId: input.traceId,
    occurredAt: input.now.toISOString(),
  };
}
