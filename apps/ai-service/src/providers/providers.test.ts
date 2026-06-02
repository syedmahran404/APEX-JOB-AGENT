import { describe, it, expect } from 'vitest';
import { DependencyError } from '@apex/shared-errors';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { classifyHttpStatus } from './http.js';
import type { fetch as UndiciFetch } from 'undici';

/** Build a fake undici fetch returning a scripted JSON body + status. */
function fakeFetch(status: number, body: unknown, capture?: (url: string, init: unknown) => void): typeof UndiciFetch {
  return ((url: unknown, init: unknown) => {
    capture?.(String(url), init);
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  }) as unknown as typeof UndiciFetch;
}

describe('providers/http classifyHttpStatus', () => {
  it('marks 429/5xx/408/409 retryable; 4xx others not', () => {
    expect(classifyHttpStatus(429, 'x').retryable).toBe(true);
    expect(classifyHttpStatus(503, 'x').retryable).toBe(true);
    expect(classifyHttpStatus(408, 'x').retryable).toBe(true);
    expect(classifyHttpStatus(400, 'x').retryable).toBe(false);
    expect(classifyHttpStatus(401, 'x').retryable).toBe(false);
  });
});

describe('AnthropicProvider', () => {
  it('maps the Messages API response and sends system top-level', async () => {
    let captured: { url: string; init: unknown } | null = null;
    const provider = new AnthropicProvider({
      apiKey: 'sk-test',
      fetchImpl: fakeFetch(
        200,
        {
          content: [{ type: 'text', text: '{"answer":30,"confidence":0.9,"rationale":"ok"}' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 120, output_tokens: 25 },
          model: 'claude-sonnet-4',
        },
        (url, init) => {
          captured = { url, init };
        },
      ),
    });
    const res = await provider.complete({
      model: 'claude-sonnet-4',
      system: 'be helpful',
      messages: [{ role: 'user', content: 'q' }],
      temperature: 0.2,
      maxTokens: 300,
      responseFormat: 'json',
    });
    expect(res.output).toContain('"answer":30');
    expect(res.usage).toEqual({ inputTokens: 120, outputTokens: 25 });
    expect(res.finishReason).toBe('stop');
    const body = JSON.parse((captured!.init as { body: string }).body) as { system: string; messages: unknown[] };
    expect(body.system).toContain('be helpful');
    expect(body.system).toContain('valid JSON'); // json-mode instruction injected
    expect(captured!.url).toContain('/v1/messages');
  });

  it('surfaces a retryable DependencyError on 429', async () => {
    const provider = new AnthropicProvider({ apiKey: 'k', fetchImpl: fakeFetch(429, { error: { message: 'rate' } }) });
    await expect(
      provider.complete({ model: 'm', system: 's', messages: [], temperature: 0, maxTokens: 10 }),
    ).rejects.toBeInstanceOf(DependencyError);
  });

  it('rejects embed (no Anthropic embeddings endpoint)', async () => {
    const provider = new AnthropicProvider({ apiKey: 'k' });
    await expect(provider.embed({ model: 'm', inputs: ['x'] })).rejects.toBeInstanceOf(DependencyError);
  });
});

describe('OpenAIProvider', () => {
  it('maps chat completions + sends system as a message + json mode', async () => {
    let captured: unknown = null;
    const provider = new OpenAIProvider({
      apiKey: 'sk',
      fetchImpl: fakeFetch(
        200,
        {
          choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
          model: 'gpt-4.1',
        },
        (_url, init) => {
          captured = init;
        },
      ),
    });
    const res = await provider.complete({
      model: 'gpt-4.1',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.1,
      maxTokens: 100,
      responseFormat: 'json',
    });
    expect(res.usage).toEqual({ inputTokens: 50, outputTokens: 10 });
    const body = JSON.parse((captured as { body: string }).body) as {
      messages: Array<{ role: string }>;
      response_format: { type: string };
    };
    expect(body.messages[0]?.role).toBe('system');
    expect(body.response_format.type).toBe('json_object');
  });

  it('embeds and preserves input order by index', async () => {
    const provider = new OpenAIProvider({
      apiKey: 'sk',
      fetchImpl: fakeFetch(200, {
        data: [
          { embedding: [0.2, 0.2], index: 1 },
          { embedding: [0.1, 0.1], index: 0 },
        ],
        usage: { prompt_tokens: 4, total_tokens: 4 },
        model: 'text-embedding-3-large',
      }),
    });
    const res = await provider.embed({ model: 'text-embedding-3-large', inputs: ['a', 'b'] });
    expect(res.vectors[0]).toEqual([0.1, 0.1]); // index 0 first
    expect(res.dim).toBe(2);
  });
});
