# Phase 2 — Folder Structure

## 1. Goals of the layout

The folder layout is a load-bearing piece of the architecture. It makes the bounded contexts visible, makes import rules enforceable, and makes onboarding a one-page exercise. Specifically, it must:

- Make the runtime shape from Phase 1 visible at a glance (one folder per deployable).
- Make domain boundaries enforceable via static rules (no app reaches into another app's internals; everything goes through `packages/*`).
- Allow shared TypeScript types and Zod schemas to be the single source of truth across client and server.
- Allow each platform adapter to be developed and tested in isolation.
- Keep infra, docs, and tooling out of the application path so they evolve independently.
- Support a clean evolution from monolith → service split without restructure.

## 2. Top-level layout

```text
apex-job-agent/
├── apps/                       # Deployables (one process per folder)
│   ├── web/                    # React 18 SPA (Vite)
│   ├── api/                    # NestJS API gateway / BFF
│   ├── orchestrator/           # NestJS state-machine service
│   ├── ai-service/             # NestJS LLM/RAG service
│   ├── automation-worker/      # Node service hosting Playwright workers
│   └── analytics/              # NestJS analytics ingest + rollups
│
├── packages/                   # Shared libraries (no process here)
│   ├── shared-types/           # Zod schemas + inferred TS types
│   ├── shared-config/          # Env loader, feature flags, logging config
│   ├── shared-logger/          # Pino base + OpenTelemetry wiring
│   ├── shared-errors/          # Typed error hierarchy + serialization
│   ├── shared-events/          # Domain event names + payload schemas
│   ├── db/                     # Prisma schema, migrations, seed, repos
│   ├── crypto/                 # Envelope encryption + KMS client wrapper
│   ├── vault-client/           # HashiCorp Vault client + lease helpers
│   ├── ai-core/                # Provider abstraction, prompt registry, eval harness
│   ├── automation-core/        # Browser pool, anti-detection, base adapter
│   ├── platform-adapters/      # One subfolder per platform (see §5)
│   ├── queue/                  # BullMQ wrappers, queue names, DLQ helpers
│   ├── realtime/               # Socket.IO server + client conventions
│   ├── ui/                     # Shared React components (design system)
│   ├── ui-icons/               # Custom icon set
│   └── testing/                # Test fixtures, factories, MSW handlers
│
├── infra/
│   ├── docker/                 # Dockerfiles per app + compose stacks
│   ├── compose/                # Local dev stacks (postgres, redis, minio, vault)
│   ├── k8s/                    # Helm chart (apex-job-agent) + values per env
│   ├── terraform/              # Cloud infra: managed PG, S3, Redis, KMS, networking
│   ├── otel/                   # Collector config, dashboards (Grafana JSON), alerts
│   └── scripts/                # One-off ops scripts (idempotent, documented)
│
├── docs/
│   ├── architecture/           # The 10 phase docs (this folder)
│   ├── adr/                    # Architecture Decision Records (numbered)
│   ├── runbooks/               # On-call procedures (filled M9)
│   ├── prompts/                # Frozen prompt versions (mirror of registry)
│   └── api/                    # OpenAPI YAML (generated) + handwritten guides
│
├── tools/
│   ├── codegen/                # OpenAPI → client, Prisma → Zod
│   ├── lint-rules/             # Custom ESLint rules (boundary enforcement)
│   └── eval-harness/           # AI eval datasets + runners
│
├── .github/
│   └── workflows/              # CI/CD pipelines
│
├── .changeset/                 # Versioning of internal packages
├── .editorconfig
├── .gitignore
├── .nvmrc
├── .prettierrc.cjs
├── eslint.config.js            # Flat config; references tools/lint-rules
├── package.json                # Root: pnpm scripts, devDeps only
├── pnpm-workspace.yaml         # Defines apps/* and packages/*
├── tsconfig.base.json          # Strict TS settings shared by all
├── turbo.json                  # Turborepo pipeline (build/test/lint/typecheck)
└── README.md
```

## 3. Why a monorepo, and why this monorepo

### Why monorepo at all
- The frontend and backend share Zod schemas; without a monorepo we'd publish a private package on every change. Friction kills velocity.
- The orchestrator, workers, AI service, and API all share `db/`, `shared-events/`, `crypto/`, `queue/`. Polyrepo means lockstep version pinning across six repos, which is a tax we don't need.
- Per-platform adapters need to share `automation-core` and be testable together; one repo, one CI run.

### Why pnpm + Turborepo
- pnpm gives us strict dependency isolation (no accidental hoisting that lets `apps/api` import `apps/web` internals).
- Turborepo gives task graph caching: `pnpm build` only rebuilds what changed. Critical at this size.
- Both have low operational ceremony compared to Nx (which we evaluated and rejected as too opinionated for a small team).

## 4. The `apps/*` contract

Every folder under `apps/` is a deployable Node process (or a Vite SPA). Each follows the same internal shape so cross-app navigation feels uniform:

```text
apps/<name>/
├── src/
│   ├── main.ts                 # Bootstrap (NestFactory or Vite entry)
│   ├── app.module.ts           # NestJS root module (where applicable)
│   ├── modules/                # Domain modules
│   │   └── <module>/
│   │       ├── <module>.module.ts
│   │       ├── <module>.controller.ts   (only in apps/api, apps/analytics)
│   │       ├── <module>.service.ts
│   │       ├── <module>.repository.ts
│   │       ├── dto/                     (Zod schemas only; types inferred)
│   │       └── <module>.spec.ts
│   ├── infra/                  # Glue: HTTP server, queue clients, OTel
│   └── config/                 # App-local config (validated env)
├── test/                       # Integration + e2e tests for this app
├── Dockerfile
├── package.json
├── tsconfig.json               # Extends ../../tsconfig.base.json
└── README.md                   # What this app owns + how to run it
```

Hard rules enforced by ESLint (`tools/lint-rules/no-cross-app-imports.ts`):
- `apps/<a>` may **not** import from `apps/<b>`.
- `apps/<a>` may import from `packages/*` freely.
- `packages/<p>` may import from other `packages/*` only if declared in its `package.json`.

## 5. The `packages/platform-adapters/` shape

Adapters are the highest-churn surface in the codebase (job sites change). They get their own conventions to keep the blast radius of any one platform's drift small.

```text
packages/platform-adapters/
├── core/                       # Re-exports from automation-core for convenience
├── linkedin/
│   ├── src/
│   │   ├── adapter.ts          # Implements PlatformAdapter interface
│   │   ├── selectors.ts        # All DOM selectors, versioned by adapter version
│   │   ├── flows/
│   │   │   ├── login.ts
│   │   │   ├── search.ts
│   │   │   ├── parse-listing.ts
│   │   │   ├── parse-job.ts
│   │   │   ├── apply.ts
│   │   │   └── answer-questions.ts
│   │   ├── fixtures/           # Saved HTML for offline tests
│   │   └── version.ts          # Exported semver; bumped on selector change
│   ├── test/
│   └── package.json
├── naukri/         (same shape)
├── indeed/         (same shape)
├── internshala/    (same shape)
├── glassdoor/      (same shape)
├── foundit/        (same shape)
├── wellfound/      (same shape)
└── upwork/         (same shape)
```

Each adapter exports a single object satisfying the `PlatformAdapter` contract from `packages/automation-core`. Workers select the adapter at runtime by platform name. New platforms drop in without touching workers.

## 6. The `packages/db/` layout

```text
packages/db/
├── prisma/
│   ├── schema.prisma           # Single source of truth (Phase 3)
│   ├── migrations/             # Generated; checked in
│   └── seed.ts                 # Idempotent dev seed
├── src/
│   ├── client.ts               # PrismaClient singleton + tracing
│   ├── repositories/           # Hand-written, Prisma-backed repositories
│   │   ├── user.repository.ts
│   │   ├── application.repository.ts
│   │   └── ...
│   ├── transactions.ts         # `runInTransaction` helper with retries
│   ├── outbox.ts               # Transactional outbox helpers
│   └── extensions/             # Prisma extensions (pgvector, audit hooks)
└── package.json
```

Repositories live here, not inside apps. That keeps SQL knowledge in one place and makes it possible to test repos against a real Postgres in `packages/db/test/` without standing up an app.

## 7. The `packages/shared-types/` layout

The single most important shared package.

```text
packages/shared-types/
├── src/
│   ├── api/                    # Request + response Zod schemas, per route
│   ├── domain/                 # User, Profile, Resume, Job, Application, ...
│   ├── events/                 # Re-exports from shared-events (typed names)
│   ├── ai/                     # Prompt I/O Zod schemas (one per prompt id)
│   └── index.ts
└── package.json
```

Rule: **no class, no interface**, only Zod schemas with `z.infer` for the matching TS type. This keeps validation and types coherent and is the foundation of "no schema drift between client and server."

## 8. The `apps/web/` layout

```text
apps/web/
├── src/
│   ├── main.tsx                # Entry; QueryClient, Router, Theme, Auth
│   ├── app/                    # Route components (file-based)
│   │   ├── (public)/           # Login, signup, marketing
│   │   ├── (authed)/
│   │   │   ├── command-center/
│   │   │   ├── profile/
│   │   │   ├── resumes/
│   │   │   ├── jobs/
│   │   │   ├── applications/
│   │   │   ├── analytics/
│   │   │   ├── settings/
│   │   │   └── activity/
│   │   └── _layout.tsx
│   ├── features/               # Feature slices (UI + hooks + queries)
│   │   ├── runs/
│   │   ├── permissions/
│   │   ├── q-a-memory/
│   │   └── ...
│   ├── components/             # App-local components (not in packages/ui)
│   ├── hooks/                  # Cross-feature hooks (useRealtime, useAuth)
│   ├── lib/                    # api-client (generated), socket, theme
│   ├── three/                  # R3F scenes (command-center hero, particles)
│   ├── motion/                 # Framer Motion variants library
│   ├── styles/                 # Tailwind config, design tokens, globals.css
│   └── test/                   # Vitest + React Testing Library + Playwright e2e
├── public/                     # Static assets
├── index.html
├── vite.config.ts
└── package.json
```

`packages/ui/` holds the design-system primitives (Button, Card, Glass, Tooltip, DataTable, ChartFrame). `apps/web/components/` holds composites that aren't reusable enough to promote.

## 9. The `apps/automation-worker/` layout

```text
apps/automation-worker/
├── src/
│   ├── main.ts                 # BullMQ Worker bootstrap
│   ├── pool/                   # Browser pool + context lifecycle
│   ├── leases/                 # Vault lease + credential redemption
│   ├── tasks/
│   │   ├── discovery.task.ts   # Run discovery for a platform
│   │   ├── apply.task.ts       # Submit one application
│   │   ├── login.task.ts       # Refresh expired session
│   │   └── health.task.ts      # Periodic anti-detection health check
│   ├── reporting/              # Outbox writer, screenshot uploader
│   └── safety/                 # CAPTCHA detector, rate-limit watcher, kill-switch
├── test/                       # Adapter integration tests against fixtures
└── package.json
```

The worker is intentionally thin. All platform-specific behavior lives in `packages/platform-adapters/<platform>`. The worker's job is lifecycle: pull task, restore context, run flow, persist results, ack.

## 10. The `apps/ai-service/` layout

```text
apps/ai-service/
├── src/
│   ├── modules/
│   │   ├── gateway/            # /score, /answer, /tailor, /cover-letter
│   │   ├── rag/                # Embed, search, rerank
│   │   ├── prompts/            # Loaders bound to packages/ai-core registry
│   │   ├── governor/           # Cost ceilings, daily budgets, tier routing
│   │   └── audit/              # Decision log writer
│   └── infra/
└── package.json
```

`packages/ai-core/` holds the *immutable* assets: the prompt registry (versioned), the eval harness, the provider abstraction, and the Zod schemas for prompt I/O. The app is the runtime that uses them.

## 11. The `infra/` layout

```text
infra/
├── docker/
│   ├── api.Dockerfile
│   ├── orchestrator.Dockerfile
│   ├── ai-service.Dockerfile
│   ├── automation-worker.Dockerfile
│   ├── analytics.Dockerfile
│   └── web.Dockerfile          # Multi-stage: build → nginx
├── compose/
│   ├── dev.compose.yaml        # All services + dependencies for local dev
│   ├── e2e.compose.yaml        # Hermetic stack for end-to-end tests
│   └── selfhost.compose.yaml   # Single-node deployment (for power users)
├── k8s/
│   ├── chart/                  # Helm chart "apex-job-agent"
│   │   ├── Chart.yaml
│   │   ├── values.yaml
│   │   ├── templates/
│   │   └── README.md
│   └── envs/
│       ├── staging.values.yaml
│       └── prod.values.yaml
├── terraform/
│   ├── modules/                # Reusable: vpc, rds, redis, s3, kms, eks
│   ├── envs/
│   │   ├── staging/
│   │   └── prod/
│   └── README.md
├── otel/
│   ├── collector.yaml
│   ├── grafana/
│   │   ├── dashboards/
│   │   └── datasources/
│   └── alerts/                 # Alertmanager rules
└── scripts/                    # idempotent, documented; no inline secrets
```

## 12. The `tools/lint-rules/` boundary enforcement

These are the rules without which the monorepo decays into a tangle.

| Rule id | Enforces |
| --- | --- |
| `apex/no-cross-app-imports` | No `apps/<a>` imports `apps/<b>`. |
| `apex/app-uses-package-only` | `apps/*` imports outside `apps/<self>` must be from `packages/*`. |
| `apex/package-declared-deps` | A package may only import packages declared in its own `package.json`. |
| `apex/no-secrets-in-source` | Pattern-detects API key shapes, refuses to lint clean. |
| `apex/zod-only-in-shared-types` | `packages/shared-types/` may not import from any other internal package (it is a leaf). |
| `apex/error-class-from-shared-errors` | Throwing raw `Error` outside `shared-errors` fails lint; encourages typed errors. |
| `apex/no-direct-prisma-in-apps` | Apps must use `packages/db` repositories, never PrismaClient directly. |

These rules live in `tools/lint-rules/` and are referenced by the root `eslint.config.js`. They run in CI as a blocking check.

## 13. CI/CD layout reference

```text
.github/workflows/
├── ci.yaml                     # On every PR: install, lint, typecheck, test, build
├── e2e.yaml                    # Nightly + on main: full Playwright suite (web + adapters against fixtures)
├── prompt-eval.yaml            # On change to packages/ai-core/prompts/**: run eval harness
├── adapter-canary.yaml         # Nightly: run each adapter's discovery against real sites in read-only mode, alert on selector drift
├── release.yaml                # Tag → build images → push → deploy via Helm
└── codeql.yaml                 # Security scanning
```

Pipeline detail: Phase 9.

## 14. Tradeoffs accepted in this layout

- **Folder explosion vs clarity.** We chose clarity. New engineers find what they need from the folder name alone; the cost is more files.
- **Strict boundaries vs convenience.** Cross-app imports would be quick wins until they aren't. Custom ESLint rules catch them at compile time.
- **Adapter-per-folder vs adapter-per-file.** Per folder costs ~8 small folders but makes platform-specific tests, fixtures, and version pinning natural. Worth it.
- **Repositories live in `packages/db`, not in apps.** Slightly more friction for app authors (one extra import) but database knowledge stays consolidated and testable.
- **Web app uses file-based routes inside `app/`.** This mirrors Next/Remix conventions even though we use Vite + react-router; payoff is familiar mental model for new contributors.

## 15. What this phase deliberately does not decide

- Specific tsconfig fields and ESLint rules — they ship in M0 with the scaffold (Phase 10).
- Specific package versions — pinned in M0 PR.
- Specific Docker base images — Phase 9.
- Specific Helm values — Phase 9.

This layout is what every later phase assumes when it points at a path.
