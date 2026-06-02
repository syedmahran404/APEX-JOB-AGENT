// VoyageProvider — real adapter for Voyage AI embeddings (registry 'embed'
// primary). Implements only embed(); complete() is rejected (Voyage is
// embeddings-only) so a misroute fails loudly rather than silently.
//
// Reference: docs/architecture/07-ai-engine.md §3 (embed tier).

import type {
  AiProvider,
  CompletionRequest,
  CompletionResult,
  EmbeddingRequest,
  EmbeddingResult,
} from '@apex/ai-core';
import { DependencyError } from '@apex/shared-errors';
import { httpJson, type FetchImpl } from './http.js';

export interface VoyageOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
}

interface VoyageResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage: { total_tokens: number };
  model: string;
}

export class VoyageProvider implements AiProvider {
  readonly name = 'voyage';
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: VoyageOptions) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.voyageai.com').replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  complete(_req: CompletionRequest): Promise<CompletionResult> {
    return Promise.reject(new DependencyError('voyage', 'Voyage is embeddings-only; route completions to anthropic/openai'));
  }

  async embed(req: EmbeddingRequest): Promise<EmbeddingResult> {
    const resp = await httpJson<VoyageResponse>({
      url: `${this.baseUrl}/v1/embeddings`,
      method: 'POST',
      headers: { authorization: `Bearer ${this.opts.apiKey}` },
      body: { model: req.model, input: req.inputs, input_type: 'document' },
      timeoutMs: this.timeoutMs,
      fetchImpl: this.opts.fetchImpl,
      dependency: 'voyage',
    });
    const sorted = [...resp.data].sort((a, b) => a.index - b.index);
    const vectors = sorted.map((d) => d.embedding);
    return {
      vectors,
      usage: { inputTokens: resp.usage.total_tokens, outputTokens: 0 },
      model: resp.model,
      dim: vectors[0]?.length ?? 0,
    };
  }
}
