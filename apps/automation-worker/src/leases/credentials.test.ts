import { describe, it, expect } from 'vitest';
import { redeemCredentials, withCredentials, type CredentialRedeemer } from './credentials.js';

const VALID = {
  username: 'alice@example.com',
  password: 'super-secret',
  auditId: '00000000-0000-4000-8000-000000000001',
};

function redeemer(resp: unknown): CredentialRedeemer {
  return { redeem: () => Promise.resolve(resp) };
}

describe('leases/credentials', () => {
  it('redeems and validates the response against the shared schema', async () => {
    const creds = await redeemCredentials(redeemer(VALID), 'tok-'.padEnd(40, 'x'));
    expect(creds.username).toBe('alice@example.com');
    expect(creds.auditId).toBe(VALID.auditId);
  });

  it('wipe() clears the plaintext fields', async () => {
    const creds = await redeemCredentials(redeemer(VALID), 'tok-'.padEnd(40, 'x'));
    creds.wipe();
    expect(creds.username).toBe('');
    expect(creds.password).toBe('');
    expect(creds.totpSeed).toBeUndefined();
  });

  it('withCredentials wipes even when the body throws', async () => {
    let captured: { username: string } | null = null;
    await expect(
      withCredentials(redeemer(VALID), 'tok-'.padEnd(40, 'x'), (creds) => {
        captured = creds;
        return Promise.reject(new Error('boom'));
      }),
    ).rejects.toThrow(/boom/);
    expect(captured).not.toBeNull();
    expect((captured as unknown as { username: string }).username).toBe(''); // wiped
  });

  it('wraps a redeem failure as a typed DependencyError', async () => {
    const failing: CredentialRedeemer = { redeem: () => Promise.reject(new Error('vault down')) };
    await expect(redeemCredentials(failing, 'tok-'.padEnd(40, 'x'))).rejects.toMatchObject({
      code: 'dependency_unavailable',
    });
  });

  it('rejects a malformed redeem response', async () => {
    await expect(redeemCredentials(redeemer({ username: 'x' }), 'tok-'.padEnd(40, 'x'))).rejects.toThrow();
  });
});
