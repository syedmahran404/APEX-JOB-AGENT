// AnthropicProvider — real adapter for the Anthropic Messages API.
//
// Implements the @apex/ai-core AiProvider port. Anthropic places the system
// prompt in a top-level `system` field (not a message), uses `x-api-key` +
// `anthropic-version` headers, and reports usage as `input_tokens`/`output_tokens`.
// JSON-mode is requested by instruction (Anthropic has no hard json flag), which
// the gateway's schema validation + stricter-retry already handle.
//
// Reference: docs/architecture/07-ai-engine.md §3.

import type {
  AiProvider,
  CompletionRequest,
  CompletionResult,
  EmbeddingRequest,
  EmbeddingResult,
} from '@apex/ai-core';
import { DependencyError } from '@apex/shared-errors';
import { httpJson, type FetchImpl } from './http.js';

export interface AnthropicOptions {
  apiKey: string;
  baseUrl?: string;
  anthropicVersion?: string;
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
}

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
}

function mapStop(reason: string | null): CompletionResult['finishReason'] {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
    case 'tool_use':
      return 'stop';
    case 'max_tokens':
      return 'length';
    default:
      return reason === null ? 'stop' : 'error';
  }
}

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  private readonly baseUrl: string;
  private readonly version: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: AnthropicOptions) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    this.version = opts.anthropicVersion ?? '2023-06-01';
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    // Anthropic only accepts user/assistant in `messages`; system goes top-level.
    const messages = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));
    const system =
      req.responseFormat === 'json'
        ? `${req.system}\n\nRespond with a single valid JSON object and nothing else.`
        : req.system;

    const body = {
      model: req.model,
      system,
      messages,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      ...(req.topP !== undefined ? { top_p: req.topP } : {}),
    };

    const resp = await httpJson<AnthropicResponse>({
      url: `${this.baseUrl}/v1/messages`,
      method: 'POST',
      headers: {
        'x-api-key': this.opts.apiKey,
        'anthropic-version': this.version,
      },
      body,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.opts.fetchImpl,
      dependency: 'anthropic',
    });

    const output = resp.content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text ?? '')
      .join('');

    return {
      output,
      usage: { inputTokens: resp.usage.input_tokens, outputTokens: resp.usage.output_tokens },
      model: resp.model,
      finishReason: mapStop(resp.stop_reason),
    };
  }

  embed(_req: EmbeddingRequest): Promise<EmbeddingResult> {
    // Anthropic does not offer a first-party embeddings endpoint; the registry
    // routes 'embed' to Voyage/OpenAI instead. This guard prevents misrouting.
    return Promise.reject(
      new DependencyError('anthropic', 'Anthropic has no embeddings endpoint; route embed tier to voyage/openai'),
    );
  }
}
