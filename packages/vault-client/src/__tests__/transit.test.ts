// Unit tests for the Transit wrap/unwrap client. We stub the http layer with a
// pure function so no Vault is required.

import { describe, expect, it, vi } from 'vitest';
import { wrapDek, unwrapDek, dekFromUnwrap } from '../transit.js';
import type { VaultHttp } from '../client.js';

interface CapturedRequest {
  path: string;
  body: { plaintext?: string; ciphertext?: string; context?: string };
}

/**
 * Build a stub VaultHttp. `impl` receives the request path and parsed JSON body
 * and returns the value the Vault endpoint would produce.
 */
function makeHttp(impl: (req: CapturedRequest) => unknown): VaultHttp {
  return {
    fetch: vi.fn(<T>(path: string, init?: { method?: string; body?: string }): Promise<T> => {
      const raw: string = init?.body ?? '{}';
      const body = JSON.parse(raw) as CapturedRequest['body'];
      return Promise.resolve(impl({ path, body }) as T);
    }),
    renewToken: vi.fn((): Promise<void> => Promise.resolve()),
  };
}

describe('vault-client/transit', () => {
  it('wrapDek POSTs base64 plaintext + returns ciphertext + key_version', async () => {
    let received: CapturedRequest | null = null;
    const http = makeHttp((req) => {
      received = req;
      return { data: { ciphertext: 'vault:v1:ABC', key_version: 3 } };
    });
    const dek = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'); // 32 bytes
    const out = await wrapDek({ http, keyAlias: 'apex-dek', dek });
    expect(out.ciphertext).toBe('vault:v1:ABC');
    expect(out.keyVersion).toBe(3);
    expect(received).not.toBeNull();
    const req = received as unknown as CapturedRequest;
    expect(req.path).toBe('/v1/transit/encrypt/apex-dek');
    expect(req.body.plaintext).toBe(dek.toString('base64'));
    expect(req.body.context).toBeUndefined();
  });

  it('wrapDek includes context when provided', async () => {
    let received: CapturedRequest | null = null;
    const http = makeHttp((req) => {
      received = req;
      return { data: { ciphertext: 'vault:v1:ABC', key_version: 1 } };
    });
    await wrapDek({ http, keyAlias: 'k', dek: Buffer.alloc(32, 1), context: Buffer.from('ctx') });
    const req = received as unknown as CapturedRequest;
    expect(req.body.context).toBe(Buffer.from('ctx').toString('base64'));
  });

  it('unwrapDek POSTs ciphertext + returns plaintext bytes', async () => {
    const expected = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
    let received: CapturedRequest | null = null;
    const http = makeHttp((req) => {
      received = req;
      return { data: { plaintext: expected.toString('base64') } };
    });
    const out = await unwrapDek({ http, keyAlias: 'k', ciphertext: 'vault:v1:ABC' });
    expect(out.equals(expected)).toBe(true);
    const req = received as unknown as CapturedRequest;
    expect(req.path).toBe('/v1/transit/decrypt/k');
    expect(req.body.ciphertext).toBe('vault:v1:ABC');
  });

  it('throws DependencyError when Vault returns no ciphertext', async () => {
    const http = makeHttp(() => ({ data: {} }));
    await expect(wrapDek({ http, keyAlias: 'k', dek: Buffer.alloc(32) })).rejects.toMatchObject({
      code: 'dependency_unavailable',
    });
  });

  it('throws DependencyError when Vault returns no plaintext', async () => {
    const http = makeHttp(() => ({ data: {} }));
    await expect(unwrapDek({ http, keyAlias: 'k', ciphertext: 'vault:v1:X' })).rejects.toMatchObject({
      code: 'dependency_unavailable',
    });
  });

  it('dekFromUnwrap assembles a Dek with the provided metadata', () => {
    const buf = Buffer.alloc(32, 7);
    const dek = dekFromUnwrap(buf, 'vault:apex-dek', 5);
    expect(dek.key.equals(buf)).toBe(true);
    expect(dek.vaultKeyId).toBe('vault:apex-dek');
    expect(dek.version).toBe(5);
  });
});
