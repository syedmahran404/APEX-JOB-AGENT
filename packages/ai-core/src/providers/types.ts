// Provider abstraction — the single interface every LLM provider implements.
//
// Reference: docs/architecture/07-ai-engine.md §3.
//
// Provider-specific quirks (tool-use formats, system-prompt placement, JSON-mode
// flags) are normalized inside each adapter. Adding a provider is one file plus
// registry registration. This module is browser-/network-free at the type level;
// the live providers implement the port, the MockProvider plays back fixtures.

export type Tier = 'reason' | 'default' | 'fast' | 'embed';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  /** Concrete model id resolved from the registry for a tier. */
  model: string;
  system: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  topP?: number | undefined;
  /** 'json' forces structured output where the provider supports it. */
  responseFormat?: 'json' | 'text' | undefined;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CompletionResult {
  /** Raw text output (parsed/validated by the caller, not here). */
  output: string;
  usage: TokenUsage;
  /** The concrete model that produced this. */
  model: string;
  /** Provider-reported finish reason, normalized. */
  finishReason: 'stop' | 'length' | 'content_filter' | 'error';
}

export interface EmbeddingRequest {
  model: string;
  /** One or more input texts to embed in a single batch. */
  inputs: string[];
}

export interface EmbeddingResult {
  /** One vector per input, in order. */
  vectors: number[][];
  usage: TokenUsage;
  model: string;
  /** Vector dimensionality (1024 or 3072 — audit A2 per-dim storage). */
  dim: number;
}

/** Normalized provider-side rate-limit signal (parsed from response headers). */
export interface RateLimitSignal {
  remaining: number;
  resetMs: number;
}

/** The one interface all providers implement. */
export interface AiProvider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
  embed(req: EmbeddingRequest): Promise<EmbeddingResult>;
}

/** A provider error the gateway can classify for retry/circuit-breaking. */
export interface ProviderErrorShape {
  status?: number | undefined;
  retryable: boolean;
  message: string;
}
