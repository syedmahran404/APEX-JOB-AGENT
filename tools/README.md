# `tools/`

Repo-wide development tooling. Not deployable; not a library consumed by `apps/*` at runtime.

| Folder | Purpose |
| --- | --- |
| [`codegen/`](./codegen) | OpenAPI → typed web SDK; Prisma → Zod helpers |
| [`lint-rules/`](./lint-rules) | Custom ESLint rules that enforce monorepo boundaries (see [Phase 2 §12](../docs/architecture/02-folder-structure.md#12-the-toolslint-rules-boundary-enforcement)) |
| [`eval-harness/`](./eval-harness) | AI eval runner; gates merges to `packages/ai-core/prompts/**` |
