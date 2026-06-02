// Vault HTTP client. Thin wrapper over undici with auth-token injection,
// JSON body handling, and consistent DependencyError surfacing.
//
// We deliberately do not use the unmaintained `node-vault` package; its API
// has not kept pace with Vault's, and we need narrow coverage anyway.

import { DependencyError } from '@apex/shared-errors';
import { fetch as undiciFetch, type RequestInit } from 'undici';

export interface VaultClientOptions {
  /** Base URL, e.g. https://vault.internal:8200. No trailing slash. */
  addr: string;
  /** Vault token; treat as a secret. Loaded from env or KV mount on the calling side. */
  token: string;
  /** Optional namespace header (Vault Enterprise). */
  namespace?: string;
  /** Default request timeout in ms. */
  timeoutMs?: number;
  /** Optional fetch implementation (for tests). */
  fetchImpl?: typeof undiciFetch;
}

export interface VaultHttp {
  fetch<T>(path: string, init?: RequestInit): Promise<T>;
  /** Renew the token; idempotent. */
  renewToken(): Promise<void>;
}

export function createVaultHttp(opts: VaultClientOptions): VaultHttp {
  const fetchImpl = opts.fetchImpl ?? undiciFetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const baseUrl = opts.addr.replace(/\/$/, '');

  async function vaultFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const headers: Record<string, string> = {
      'X-Vault-Token': opts.token,
      'Content-Type': 'application/json',
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    };
    if (opts.namespace) headers['X-Vault-Namespace'] = opts.namespace;
    try {
      const resp = await fetchImpl(url, { ...init, headers, signal: ac.signal });
      const text = await resp.text();
      if (!resp.ok) {
        let detail = text;
        try {
          const j = JSON.parse(text) as { errors?: string[] };
          if (Array.isArray(j.errors)) detail = j.errors.join('; ');
        } catch {
          /* ignore */
        }
        throw new DependencyError('vault', `Vault ${String(resp.status)} on ${path}: ${detail}`);
      }
      return text ? (JSON.parse(text) as T) : ({} as T);
    } catch (err) {
      if (err instanceof DependencyError) throw err;
      throw new DependencyError('vault', `Vault request failed: ${(err as Error).message}`, err);
    } finally {
      clearTimeout(t);
    }
  }

  return {
    fetch: vaultFetch,
    async renewToken(): Promise<void> {
      await vaultFetch<unknown>('/v1/auth/token/renew-self', { method: 'POST' });
    },
  };
}
