import { describe, it, expect } from 'vitest';
import { MockProvider, type ModelRegistry, type AiProvider } from '@apex/ai-core';
import { DependencyError } from '@apex/shared-errors';
import { ProviderRouter, type ProviderMap } from './router.js';

const REG: ModelRegistry = {
  reason: {
    primary: { provider: 'anthropic', model: 'a-primary', inputPer1M: 1, outputPer1M: 1 },
    backup: { provider: 'openai', model: 'o-backup', inputPer1M: 1, outputPer1M: 1 },
  },
  default: { primary: { provider: 'anthropic', model: 'a-def', inputPer1M: 1, outputPer1M: 1 } },
  fast: { primary: { provider: 'anthropic', model: 'a-fast', inputPer1M: 1, outputPer1M: 1 } },
  embed: {
    primary: { provider: 'voyage', model: 'v', inputPer1M: 1, outputPer1M: 0 },
    backup: { provider: 'openai', model: 'o-embed', inputPer1M: 1, outputPer1M: 0 },
  },
};

/** A provider that always throws the given error. */
function failing(name: string, retryable: boolean): AiProvider {
  const err = new DependencyError(name, 'boom', { retryable });
  return {
    name,
    complete: () => Promise.reject(err),
    embed: () => Promise.reject(err),
  };
}

describe('ProviderRouter', () => {
  const baseReq = {
    system: 's',
    messages: [{ role: 'user' as const, content: 'q' }],
    temperature: 0.2,
    maxTokens: 100,
  };

  it('uses the primary provider on success', async () => {
    const providers: ProviderMap = { anthropic: new MockProvider({ name: 'anthropic' }) };
    const router = new ProviderRouter(REG, providers);
    const out = await router.complete('reason', baseReq);
    expect(out.usedBackup).toBe(false);
    expect(out.model.model).toBe('a-primary');
  });

  it('fails over to the backup on a RETRYABLE primary error', async () => {
    const providers: ProviderMap = {
      anthropic: failing('anthropic', true),
      openai: new MockProvider({ name: 'openai' }),
    };
    const router = new ProviderRouter(REG, providers);
    const out = await router.complete('reason', baseReq);
    expect(out.usedBackup).toBe(true);
    expect(out.model.model).toBe('o-backup');
  });

  it('does NOT fail over on a non-retryable error', async () => {
    const providers: ProviderMap = {
      anthropic: failing('anthropic', false),
      openai: new MockProvider({ name: 'openai' }),
    };
    const router = new ProviderRouter(REG, providers);
    await expect(router.complete('reason', baseReq)).rejects.toBeInstanceOf(DependencyError);
  });

  it('does NOT fail over when there is no backup configured', async () => {
    const providers: ProviderMap = { anthropic: failing('anthropic', true) };
    const router = new ProviderRouter(REG, providers);
    await expect(router.complete('default', baseReq)).rejects.toBeInstanceOf(DependencyError);
  });

  it('throws a clear error when a provider instance is missing', async () => {
    const router = new ProviderRouter(REG, {}); // no providers registered
    await expect(router.complete('default', baseReq)).rejects.toThrow(/No provider instance/);
  });

  it('routes embeddings with the same primary→backup failover', async () => {
    const providers: ProviderMap = {
      voyage: failing('voyage', true),
      openai: new MockProvider({ name: 'openai', embedDim: 8 }),
    };
    const router = new ProviderRouter(REG, providers);
    const out = await router.embed(['hello']);
    expect(out.usedBackup).toBe(true);
    expect(out.result.dim).toBe(8);
  });
});
