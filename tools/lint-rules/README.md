# `tools/lint-rules`

Custom ESLint rules. Without these, the monorepo decays into a tangle.

Reference: [Phase 2 §12](../../docs/architecture/02-folder-structure.md#12-the-toolslint-rules-boundary-enforcement).

| Rule id | Enforces |
| --- | --- |
| `apex/no-cross-app-imports` | No `apps/<a>` imports `apps/<b>` |
| `apex/app-uses-package-only` | `apps/*` imports outside `apps/<self>` must come from `packages/*` |
| `apex/package-declared-deps` | A package may only import packages declared in its own `package.json` |
| `apex/no-secrets-in-source` | Pattern-detects API key shapes; refuses to lint clean |
| `apex/zod-only-in-shared-types` | `packages/shared-types/` may not import any other internal package |
| `apex/error-class-from-shared-errors` | Throwing raw `Error` outside `shared-errors` fails lint |
| `apex/no-direct-prisma-in-apps` | Apps must use `@apex/db` repositories, never `PrismaClient` directly |

Rules run in CI as a blocking check.
