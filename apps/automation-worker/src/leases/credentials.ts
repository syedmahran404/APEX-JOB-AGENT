// Credential lease redemption. The worker never holds long-lived credentials:
// the orchestrator issues a short-lived redemption token, the worker redeems it
// for the platform login bundle, uses it within seconds, and best-effort wipes
// the plaintext from memory.
//
// Reference: docs/architecture/08-security-architecture.md §6.2.

import { RedeemResponse } from '@apex/vault-client';
import { DependencyError } from '@apex/shared-errors';

/** Redeems a one-time token for credentials. Implemented against apps/api. */
export interface CredentialRedeemer {
  redeem(redemptionToken: string): Promise<unknown>;
}

export interface PlatformCredentials {
  username: string;
  password: string;
  totpSeed?: string | undefined;
  auditId: string;
  /** Best-effort wipe of the plaintext fields. */
  wipe(): void;
}

/**
 * Redeem a lease and return a credentials handle with a `wipe()`. The response is
 * validated against the shared RedeemResponse schema (defense at the boundary).
 */
export async function redeemCredentials(
  redeemer: CredentialRedeemer,
  redemptionToken: string,
): Promise<PlatformCredentials> {
  const raw = await redeemer.redeem(redemptionToken).catch((err: unknown) => {
    throw new DependencyError('vault-redeem', 'Failed to redeem credential lease', err);
  });
  const parsed = RedeemResponse.parse(raw);
  const creds = {
    username: parsed.username,
    password: parsed.password,
    totpSeed: parsed.totpSeed,
    auditId: parsed.auditId,
    wipe(): void {
      // Overwrite the references; the underlying strings are immutable in JS, but
      // dropping references makes them GC-eligible and prevents accidental reuse.
      (this as { username: string }).username = '';
      (this as { password: string }).password = '';
      (this as { totpSeed?: string | undefined }).totpSeed = undefined;
    },
  };
  return creds;
}

/**
 * Run `fn` with redeemed credentials, guaranteeing the plaintext is wiped
 * afterwards even if `fn` throws. This is the only sanctioned way to use a lease.
 */
export async function withCredentials<T>(
  redeemer: CredentialRedeemer,
  redemptionToken: string,
  fn: (creds: PlatformCredentials) => Promise<T>,
): Promise<T> {
  const creds = await redeemCredentials(redeemer, redemptionToken);
  try {
    return await fn(creds);
  } finally {
    creds.wipe();
  }
}
