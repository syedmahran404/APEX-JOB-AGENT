// OpenAIProvider — real adapter for the OpenAI Chat Completions + Embeddings
// APIs. Implements the @apex/ai-core AiProvider port. OpenAI takes the system
// prompt as a message with role 'system', supports `response_format` JSON mode,
// and reports usage as prompt_tokens/completion_tokens.
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

export interface OpenAIOptions {
  apiKey: string;
  baseUrl?: string;
  organization?: string;
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
}

interface ChatResponse {
  choices: Array<{ message: { content: string | null }; finish_reason: string }>;
  usage: { prompt_tokens: number; completion_tokens: number };
  model: string;
}

interface EmbedResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage: { prompt_tokens: number; total_tokens: number };
  model: string;
}

function mapFinish(reason: string): CompletionResult['finishReason'] {
  switch (reason) {
    case 'stop':
    case 'tool_calls':
    case 'function_call':
      return 'stop';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'error';
  }
}

export class OpenAIProvider implements AiProvider {
  readonly name = 'openai';
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: OpenAIOptions) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com').replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { authorization: `Bearer ${this.opts.apiKey}` };
    if (this.opts.organization) h['openai-organization'] = this.opts.organization;
    return h;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const messages = [
      { role: 'system' as const, content: req.system },
      ...req.messages.filter((m) => m.role !== 'system'),
    ];
    const body = {
      model: req.model,
      messages,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      ...(req.topP !== undefined ? { top_p: req.topP } : {}),
      ...(req.responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
    };

    const resp = await httpJson<ChatResponse>({
      url: `${this.baseUrl}/v1/chat/completions`,
      method: 'POST',
      headers: this.headers(),
      body,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.opts.fetchImpl,
      dependency: 'openai',
    });

    const choice = resp.choices[0];
    if (!choice) {
      throw new DependencyError('openai', 'OpenAI returned no choices');
    }
    return {
      output: choice.message.content ?? '',
      usage: { inputTokens: resp.usage.prompt_tokens, outputTokens: resp.usage.completion_tokens },
      model: resp.model,
      finishReason: mapFinish(choice.finish_reason),
    };
  }

  async embed(req: EmbeddingRequest): Promise<EmbeddingResult> {
    const resp = await httpJson<EmbedResponse>({
      url: `${this.baseUrl}/v1/embeddings`,
      method: 'POST',
      headers: this.headers(),
      body: { model: req.model, input: req.inputs },
      timeoutMs: this.timeoutMs,
      fetchImpl: this.opts.fetchImpl,
      dependency: 'openai',
    });
    // Preserve input order by sorting on the returned index.
    const sorted = [...resp.data].sort((a, b) => a.index - b.index);
    const vectors = sorted.map((d) => d.embedding);
    const dim = vectors[0]?.length ?? 0;
    return {
      vectors,
      usage: { inputTokens: resp.usage.prompt_tokens, outputTokens: 0 },
      model: resp.model,
      dim,
    };
  }
}
