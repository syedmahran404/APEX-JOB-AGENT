// MockProvider — plays back fixtures deterministically. Used by unit tests and
// the e2e compose. It implements the full AiProvider port so every gateway path
// (validation, retry, fallback, cost, audit) can be exercised with no network.
//
// Reference: docs/architecture/07-ai-engine.md §18.

import type {
  AiProvider,
  CompletionRequest,
  CompletionResult,
  EmbeddingRequest,
  EmbeddingResult,
} from './types.js';

/** A scripted completion: matched by a predicate over the request. */
export interface MockCompletionRule {
  /** Optional matcher; when omitted, matches any request. */
  when?: (req: CompletionRequest) => boolean;
  /** The output text to return (caller validates). */
  output: string;
  usage?: { inputTokens: number; outputTokens: number } | undefined;
  finishReason?: CompletionResult['finishReason'] | undefined;
}

export interface MockProviderOptions {
  name?: string;
  completions?: MockCompletionRule[];
  /** Deterministic embedding dimension. */
  embedDim?: number;
}

/** Deterministic pseudo-embedding from text (stable, unit-normalized-ish). */
export function fakeEmbed(text: string, dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    v[(code + i) % dim] = (v[(code + i) % dim] ?? 0) + ((code % 13) - 6) / 6;
  }
  // L2 normalize so cosine is meaningful in tests.
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export class MockProvider implements AiProvider {
  readonly name: string;
  private readonly rules: MockCompletionRule[];
  private readonly embedDim: number;
  /** Records every completion request for test assertions. */
  public readonly calls: CompletionRequest[] = [];

  constructor(opts: MockProviderOptions = {}) {
    this.name = opts.name ?? 'mock';
    this.rules = opts.completions ?? [];
    this.embedDim = opts.embedDim ?? 1024;
  }

  complete(req: CompletionRequest): Promise<CompletionResult> {
    this.calls.push(req);
    const rule = this.rules.find((r) => (r.when ? r.when(req) : true));
    if (!rule) {
      return Promise.resolve({
        output: '{}',
        usage: { inputTokens: 10, outputTokens: 2 },
        model: req.model,
        finishReason: 'stop',
      });
    }
    return Promise.resolve({
      output: rule.output,
      usage: rule.usage ?? { inputTokens: 20, outputTokens: 10 },
      model: req.model,
      finishReason: rule.finishReason ?? 'stop',
    });
  }

  embed(req: EmbeddingRequest): Promise<EmbeddingResult> {
    const vectors = req.inputs.map((t) => fakeEmbed(t, this.embedDim));
    return Promise.resolve({
      vectors,
      usage: { inputTokens: req.inputs.join(' ').length, outputTokens: 0 },
      model: req.model,
      dim: this.embedDim,
    });
  }
}
