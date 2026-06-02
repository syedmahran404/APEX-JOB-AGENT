// ProviderRouter — resolves a tier to its concrete model + provider via the
// model registry and executes the call, transparently failing over from the
// primary model/provider to the backup on a RETRYABLE provider error.
//
// This is the provider-routing layer (distinct from the gateway's prompt-level
// fallback ladder, which downgrades TIERS after a *validation* failure). Here we
// only handle provider transport/availability failures.
//
// Reference: docs/architecture/07-ai-engine.md §3.

import {
  resolveModel,
  type AiProvider,
  type CompletionRequest,
  type CompletionResult,
  type EmbeddingResult,
  type ModelRegistry,
  type ModelSpec,
  type Tier,
} from '@apex/ai-core';
import { DependencyError } from '@apex/shared-errors';

export type ProviderName = ModelSpec['provider'];

/** Map of provider name → live provider instance. */
export type ProviderMap = Partial<Record<ProviderName, AiProvider>>;

export interface RouterResult<T> {
  result: T;
  /** The model spec that actually produced the result (primary or backup). */
  model: ModelSpec;
  usedBackup: boolean;
}

function isRetryable(err: unknown): boolean {
  if (err instanceof DependencyError) {
    // DependencyError stores the extra metadata in `cause` (its `details` is
    // forced to `{ dependency }`). The providers/http layer puts `{ retryable }`
    // there; a missing flag is treated as non-retryable (fail closed).
    const cause = (err as { cause?: unknown }).cause as { retryable?: boolean } | undefined;
    return cause?.retryable === true;
  }
  return false;
}

export class ProviderRouter {
  constructor(
    private readonly registry: ModelRegistry,
    private readonly providers: ProviderMap,
  ) {}

  private providerFor(spec: ModelSpec): AiProvider {
    const p = this.providers[spec.provider];
    if (!p) {
      throw new DependencyError(spec.provider, `No provider instance registered for "${spec.provider}"`);
    }
    return p;
  }

  /**
   * Run a completion for a tier. Tries the primary model/provider; on a retryable
   * provider error, fails over to the backup (when configured). The supplied
   * `model` field of `req` is overwritten with the resolved concrete model.
   */
  async complete(tier: Tier, req: Omit<CompletionRequest, 'model'>): Promise<RouterResult<CompletionResult>> {
    const primary = resolveModel(this.registry, tier, false);
    try {
      const provider = this.providerFor(primary);
      const result = await provider.complete({ ...req, model: primary.model });
      return { result, model: primary, usedBackup: false };
    } catch (err) {
      const backup = resolveModel(this.registry, tier, true);
      const hasBackup = backup.model !== primary.model || backup.provider !== primary.provider;
      if (hasBackup && isRetryable(err)) {
        const provider = this.providerFor(backup);
        const result = await provider.complete({ ...req, model: backup.model });
        return { result, model: backup, usedBackup: true };
      }
      throw err;
    }
  }

  /** Run an embedding for the embed tier with the same primary→backup failover. */
  async embed(inputs: string[]): Promise<RouterResult<EmbeddingResult>> {
    const primary = resolveModel(this.registry, 'embed', false);
    try {
      const provider = this.providerFor(primary);
      const result = await provider.embed({ model: primary.model, inputs });
      return { result, model: primary, usedBackup: false };
    } catch (err) {
      const backup = resolveModel(this.registry, 'embed', true);
      const hasBackup = backup.model !== primary.model || backup.provider !== primary.provider;
      if (hasBackup && isRetryable(err)) {
        const provider = this.providerFor(backup);
        const result = await provider.embed({ model: backup.model, inputs });
        return { result, model: backup, usedBackup: true };
      }
      throw err;
    }
  }
}
