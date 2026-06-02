// @apex/testing — Testcontainers helpers + deterministic factories.
// Used by integration tests that need a real PG / Redis / Vault.

export { startPostgres, type PostgresContainerHandle } from './testcontainers.js';
export { userFactory, platformFixture, type UserFixture, type PlatformFixture } from './factories.js';
