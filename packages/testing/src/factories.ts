// Test factories. Each returns a valid object suitable for repository inserts.
// They intentionally do NOT touch the DB; callers compose them with their
// repositories. Deterministic-by-default for snapshot stability.

import { randomBytes, randomUUID } from 'node:crypto';

let seq = 0;
function nextSeq(): number {
  return ++seq;
}

export function userFactory(overrides: Partial<UserFixture> = {}): UserFixture {
  const n = nextSeq();
  return {
    id: overrides.id ?? randomUUID(),
    tenantId: overrides.tenantId ?? '00000000-0000-0000-0000-000000000000',
    email: overrides.email ?? `user${String(n)}@apex.test`,
    displayName: overrides.displayName ?? `Apex User ${String(n)}`,
    passwordHash: overrides.passwordHash ?? 'argon2$placeholder',
    dataKeyId: overrides.dataKeyId ?? 'vault:test/dek',
    dataKeyWrapped: overrides.dataKeyWrapped ?? randomBytes(64),
  };
}

export interface UserFixture {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  passwordHash: string;
  dataKeyId: string;
  dataKeyWrapped: Buffer;
}

export function platformFixture(key: string, ordinal: number): PlatformFixture {
  return {
    id: randomUUID(),
    key,
    label: key.charAt(0).toUpperCase() + key.slice(1),
    baseUrl: `https://www.${key}.com`,
    enabled: true,
    ordinal,
  };
}

export interface PlatformFixture {
  id: string;
  key: string;
  label: string;
  baseUrl: string;
  enabled: boolean;
  ordinal: number;
}
