// Vault Transit secrets engine — wrap/unwrap data keys.
//
// The application *never* receives a KEK; it asks Vault to wrap/unwrap a DEK
// on its behalf. Plaintext DEKs flow only through the requesting process and
// are wiped after use.

import { DependencyError } from '@apex/shared-errors';
import { type Dek } from '@apex/crypto';
import { type VaultHttp } from './client.js';

export interface TransitWrapInput {
  http: VaultHttp;
  /** Vault key alias used to wrap. */
  keyAlias: string;
  /** Plaintext DEK — never stored beyond this call. */
  dek: Buffer;
  /** Bound context (binds ciphertext to the wrapped key version + alias). */
  context?: Buffer;
}

export interface TransitWrapOutput {
  /** Vault-encoded ciphertext (`vault:v1:...`). */
  ciphertext: string;
  /** Key version used to wrap; rotation increments. */
  keyVersion: number;
}

export interface TransitUnwrapInput {
  http: VaultHttp;
  keyAlias: string;
  ciphertext: string;
  context?: Buffer;
}

interface VaultTransitEncryptResp {
  data?: { ciphertext?: string; key_version?: number };
}

interface VaultTransitDecryptResp {
  data?: { plaintext?: string };
}

/** Wrap a plaintext DEK under a Vault Transit key. Returns the Vault-encoded ciphertext. */
export async function wrapDek(input: TransitWrapInput): Promise<TransitWrapOutput> {
  const body: Record<string, string> = {
    plaintext: input.dek.toString('base64'),
  };
  if (input.context) body.context = input.context.toString('base64');

  const resp = await input.http.fetch<VaultTransitEncryptResp>(
    `/v1/transit/encrypt/${encodeURIComponent(input.keyAlias)}`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
  const ct = resp.data?.ciphertext;
  const ver = resp.data?.key_version;
  if (typeof ct !== 'string' || typeof ver !== 'number') {
    throw new DependencyError('vault', 'Vault transit/encrypt returned no ciphertext');
  }
  return { ciphertext: ct, keyVersion: ver };
}

/** Unwrap a previously wrapped DEK. Returns the plaintext key bytes. */
export async function unwrapDek(input: TransitUnwrapInput): Promise<Buffer> {
  const body: Record<string, string> = { ciphertext: input.ciphertext };
  if (input.context) body.context = input.context.toString('base64');

  const resp = await input.http.fetch<VaultTransitDecryptResp>(
    `/v1/transit/decrypt/${encodeURIComponent(input.keyAlias)}`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
  const pt = resp.data?.plaintext;
  if (typeof pt !== 'string') {
    throw new DependencyError('vault', 'Vault transit/decrypt returned no plaintext');
  }
  return Buffer.from(pt, 'base64');
}

/** Convenience: assemble a Dek from a Vault unwrap. */
export function dekFromUnwrap(buf: Buffer, vaultKeyId: string, version: number): Dek {
  return { key: buf, vaultKeyId, version };
}
