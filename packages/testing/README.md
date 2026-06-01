# `@apex/testing`

Test utilities: factories, fixtures, MSW handlers, Testcontainers helpers.

Reference: [Phase 4 §9](../../docs/architecture/04-backend-design.md#9-testing-strategy).

Contents:
- Factories that produce valid Zod-shaped objects for `users`, `resumes`, `jobs`, `applications`, etc.
- Testcontainers bootstrap for PG (with extensions) + Redis + MinIO + Vault dev.
- MSW handlers for fake provider responses (Anthropic / OpenAI / S3) used in unit tests.
- Helpers for the frontend: query-client wrapper, motion-disabled wrapper for snapshot stability.
