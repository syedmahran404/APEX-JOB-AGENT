// Unit tests for the Transit wrap/unwrap client. We stub the http layer with a
// pure function so no Vault is required.

import { describe, expect, it, vi } from 'vitest';
import { wrapDek, unwrapDek, dekFromUnwrap } from '../transit.js';
import type { VaultHttp } from '../client.js';

function makeHttp(impl: (path: string, init?: { method?: string; body?: string }) => unknown): VaultHttp {
  return {
    fetch: vi.fn(async (path, init) => Promise.resolve(impl(path, init as { method?: string; body?: string }) as never)),
    renewToken: vi.fn(async () => Promise.resolve()),
  };
}

describe('vault-client/transit', () => {
  it('wrapDek POSTs base64 plaintext + returns ciphertext + key_version', async () => {
    let received: { path: string; body: { plaintext: string; context?: string } } | null = null;
    const http = makeHttp((path, init) => {
      received = { path, body: JSON.parse(init?.body ?? '{}') as { plaintext: string; context?: string } };
      return { data: { ciphertext: 'vault:v1:ABC', key_version: 3 } };
    });
    const dek = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'); // 32 bytes
    const out = await wrapDek({ http, keyAlias: 'apex-dek', dek });
    expect(out.ciphertext).toBe('vault:v1:ABC');
    expect(out.keyVersion).toBe(3);
    expect(received?.path).toBe('/v1/transit/encrypt/apex-dek');
    expect(received?.body.plaintext).toBe(dek.toString('base64'));
    expect(received?.body.context).toBeUndefined();
  });

  it('wrapDek includes context when provided', async () => {
    let received: { body: { context?: string } } | null = null;
    const http = makeHttp((_path, init) => {
      received = { body: JSON.parse(init?.body ?? '{}') as { context?: string } };
      return { data: { ciphertext: 'vault:v1:ABC', key_version: 1 } };
    });
    await wrapDek({ http, keyAlias: 'k', dek: Buffer.alloc(32, 1), context: Buffer.from('ctx') });
    expect(received?.body.context).toBe(Buffer.from('ctx').toString('base64'));
  });

  it('unwrapDek POSTs ciphertext + returns plaintext bytes', async () => {
    const expected = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
    let received: { path: string; body: { ciphertext: string } } | null = null;
    const http = makeHttp((path, init) => {
      received = { path, body: JSON.parse(init?.body ?? '{}') as { ciphertext: string } };
      return { data: { plaintext: expected.toString('base64') } };
    });
    const out = await unwrapDek({ http, keyAlias: 'k', ciphertext: 'vault:v1:ABC' });
    expect(out.equals(expected)).toBe(true);
    expect(received?.path).toBe('/v1/transit/decrypt/k');
    expect(received?.body.ciphertext).toBe('vault:v1:ABC');
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
