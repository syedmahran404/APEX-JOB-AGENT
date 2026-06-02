// Shared HTTP helper for LLM providers — thin undici wrapper with timeout,
// JSON handling, retry-classification, and consistent DependencyError surfacing.
// Mirrors the pattern in @apex/vault-client/client.ts.

import { DependencyError } from '@apex/shared-errors';
import { fetch as undiciFetch, type RequestInit } from 'undici';
import type { ProviderErrorShape } from '@apex/ai-core';

export type FetchImpl = typeof undiciFetch;

export interface HttpJsonOptions {
  url: string;
  method?: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  fetchImpl?: FetchImpl | undefined;
  /** Provider name for error attribution. */
  dependency: string;
}

/** Classify an HTTP status into a retryable provider error shape. */
export function classifyHttpStatus(status: number, message: string): ProviderErrorShape {
  // 408 timeout, 409 conflict, 429 rate-limit, 5xx server → retryable.
  const retryable = status === 408 || status === 409 || status === 429 || (status >= 500 && status < 600);
  return { status, retryable, message };
}

/** POST/GET JSON with timeout; throws DependencyError on transport/HTTP error. */
export async function httpJson<T>(opts: HttpJsonOptions): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? undiciFetch;
  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort();
  }, opts.timeoutMs);
  const init: RequestInit = {
    method: opts.method ?? 'POST',
    headers: { 'content-type': 'application/json', ...opts.headers },
    signal: ac.signal,
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  try {
    const resp = await fetchImpl(opts.url, init);
    const text = await resp.text();
    if (!resp.ok) {
      const shape = classifyHttpStatus(resp.status, summarizeError(text));
      throw new DependencyError(
        opts.dependency,
        `${opts.dependency} ${String(resp.status)}: ${shape.message}`,
        { retryable: shape.retryable, status: resp.status },
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  } catch (err) {
    if (err instanceof DependencyError) throw err;
    // Transport-level errors (timeout/abort/DNS) are retryable.
    throw new DependencyError(opts.dependency, `${opts.dependency} request failed: ${(err as Error).message}`, {
      retryable: true,
      cause: (err as Error).message,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Extract a short error message from a provider JSON/text body. */
function summarizeError(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    if (typeof j.error === 'object' && j.error?.message) return j.error.message;
    if (typeof j.error === 'string') return j.error;
    if (j.message) return j.message;
  } catch {
    /* not JSON */
  }
  return text.slice(0, 300);
}
