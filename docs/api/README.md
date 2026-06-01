# API documentation

`openapi.yaml` (generated from Zod via `@asteasolutions/zod-to-openapi`) is the canonical contract.

Reference: [Phase 4 §3.7](../architecture/04-backend-design.md#37-openapi-sdk-and-contract-testing).

The web SDK in `apps/web/src/lib/api-client/` is generated from this file by `tools/codegen/openapi-to-client.ts`. Drift is caught in CI via the `openapi:check` task.
