# `tools/codegen`

Code generators for cross-process contracts.

Generators (added in M0):
- `openapi-to-client.ts` — produces the typed web SDK (`apps/web/src/lib/api-client/`) from `docs/api/openapi.yaml`. Output uses Zod parsers, no `any`.
- `prisma-to-zod.ts` — produces Zod schemas from the Prisma schema for the subset of domain shapes that need them (most are written by hand in `packages/shared-types`).
