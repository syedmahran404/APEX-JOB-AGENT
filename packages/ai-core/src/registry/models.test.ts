import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REGISTRY,
  MOCK_REGISTRY,
  resolveModel,
  estimateCost,
  downgradeTier,
} from './models.js';

describe('registry/models', () => {
  it('resolves primary and backup per tier', () => {
    expect(resolveModel(DEFAULT_REGISTRY, 'default').model).toBe('claude-sonnet-4');
    expect(resolveModel(DEFAULT_REGISTRY, 'default', true).model).toBe('gpt-4.1');
  });

  it('falls back to primary when no backup exists', () => {
    expect(resolveModel(MOCK_REGISTRY, 'reason', true).model).toBe('mock-reason');
  });

  it('estimateCost computes input+output USD', () => {
    const spec = { provider: 'anthropic' as const, model: 'x', inputPer1M: 3, outputPer1M: 15 };
    // 1M input @ $3 + 1M output @ $15 = $18
    expect(estimateCost(spec, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(18, 5);
  });

  it('downgradeTier walks reason → default → fast → null', () => {
    expect(downgradeTier('reason')).toBe('default');
    expect(downgradeTier('default')).toBe('fast');
    expect(downgradeTier('fast')).toBeNull();
    expect(downgradeTier('embed')).toBeNull();
  });
});
