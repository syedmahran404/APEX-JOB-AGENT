// Model registry — maps abstract tiers to concrete provider models with backup
// ladders. Switching providers/models is a config change here, never a refactor.
//
// Reference: docs/architecture/07-ai-engine.md §3.
//
// The concrete defaults below mirror the spec's table; production overrides them
// via the registry rows. The price table feeds the cost governor's estimates.

import type { Tier } from '../providers/types.js';

export interface ModelSpec {
  provider: 'anthropic' | 'openai' | 'voyage' | 'mock';
  model: string;
  /** USD per 1M input / output tokens (for cost estimation). */
  inputPer1M: number;
  outputPer1M: number;
}

export interface TierBinding {
  primary: ModelSpec;
  /** Backup model used when the primary fails its fallback condition. */
  backup?: ModelSpec | undefined;
}

export type ModelRegistry = Record<Tier, TierBinding>;

/** Default registry mirroring the spec (rotated in production via config). */
export const DEFAULT_REGISTRY: ModelRegistry = {
  reason: {
    primary: { provider: 'anthropic', model: 'claude-opus-4', inputPer1M: 15, outputPer1M: 75 },
    backup: { provider: 'openai', model: 'o-class-reasoning', inputPer1M: 15, outputPer1M: 60 },
  },
  default: {
    primary: { provider: 'anthropic', model: 'claude-sonnet-4', inputPer1M: 3, outputPer1M: 15 },
    backup: { provider: 'openai', model: 'gpt-4.1', inputPer1M: 2.5, outputPer1M: 10 },
  },
  fast: {
    primary: { provider: 'anthropic', model: 'claude-haiku-4', inputPer1M: 0.8, outputPer1M: 4 },
    backup: { provider: 'openai', model: 'gpt-4o-mini', inputPer1M: 0.15, outputPer1M: 0.6 },
  },
  embed: {
    primary: { provider: 'voyage', model: 'voyage-2-large', inputPer1M: 0.12, outputPer1M: 0 },
    backup: { provider: 'openai', model: 'text-embedding-3-large', inputPer1M: 0.13, outputPer1M: 0 },
  },
};

/** A registry where every tier resolves to the mock model (for tests). */
export const MOCK_REGISTRY: ModelRegistry = {
  reason: { primary: { provider: 'mock', model: 'mock-reason', inputPer1M: 1, outputPer1M: 1 } },
  default: { primary: { provider: 'mock', model: 'mock-default', inputPer1M: 1, outputPer1M: 1 } },
  fast: { primary: { provider: 'mock', model: 'mock-fast', inputPer1M: 1, outputPer1M: 1 } },
  embed: { primary: { provider: 'mock', model: 'mock-embed', inputPer1M: 1, outputPer1M: 0 } },
};

/** Resolve the concrete model for a tier (primary unless `useBackup`). */
export function resolveModel(registry: ModelRegistry, tier: Tier, useBackup = false): ModelSpec {
  const binding = registry[tier];
  if (useBackup && binding.backup) return binding.backup;
  return binding.primary;
}

/** Estimate USD cost for a usage on a given model spec. */
export function estimateCost(model: ModelSpec, usage: { inputTokens: number; outputTokens: number }): number {
  const input = (usage.inputTokens / 1_000_000) * model.inputPer1M;
  const output = (usage.outputTokens / 1_000_000) * model.outputPer1M;
  return Number((input + output).toFixed(6));
}

/** The ordered downgrade path under budget pressure: reason → default → fast. */
export const DOWNGRADE_LADDER: Tier[] = ['reason', 'default', 'fast'];

/** Next-cheaper tier, or null when already cheapest. (embed is not downgraded.) */
export function downgradeTier(tier: Tier): Tier | null {
  if (tier === 'embed') return null;
  const idx = DOWNGRADE_LADDER.indexOf(tier);
  if (idx < 0 || idx === DOWNGRADE_LADDER.length - 1) return null;
  return DOWNGRADE_LADDER[idx + 1] ?? null;
}
