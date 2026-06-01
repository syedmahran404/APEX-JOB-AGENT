# `packages/`

Shared libraries. No deployable processes. Apps under `apps/*` depend on these; the converse is forbidden.

| Package | Purpose | Phase reference |
| --- | --- | --- |
| [`shared-types/`](./shared-types) | Zod schemas + inferred TS types — single source of truth | [Phase 2 §7](../docs/architecture/02-folder-structure.md#7-the-packagesshared-types-layout) |
| [`shared-config/`](./shared-config) | Env loader (Zod-validated), feature flags, logging config | [Phase 4 §7](../docs/architecture/04-backend-design.md#7-configuration-management) |
| [`shared-logger/`](./shared-logger) | Pino + OpenTelemetry; PII redaction defaults | [Phase 4 §8](../docs/architecture/04-backend-design.md#8-logging-tracing-metrics) |
| [`shared-errors/`](./shared-errors) | Typed error hierarchy + serialization | [Phase 4 §3.6](../docs/architecture/04-backend-design.md#36-error-model) |
| [`shared-events/`](./shared-events) | Domain event names + payload schemas; state-machine reducers | [Phase 4 §4.2](../docs/architecture/04-backend-design.md#42-run-state-machine) |
| [`db/`](./db) | Prisma schema, migrations, seed, repositories, outbox helpers | [Phase 3](../docs/architecture/03-database-design.md) |
| [`crypto/`](./crypto) | Envelope encryption primitives, AAD helpers | [Phase 8 §3](../docs/architecture/08-security-architecture.md#3-cryptographic-architecture) |
| [`vault-client/`](./vault-client) | Vault SDK wrapper + lease/redeem helpers | [Phase 8 §6](../docs/architecture/08-security-architecture.md#6-credential-vault) |
| [`ai-core/`](./ai-core) | Prompt registry, provider abstraction, eval harness primitives, calibration | [Phase 7](../docs/architecture/07-ai-engine.md) |
| [`automation-core/`](./automation-core) | Browser pool, anti-detection, base adapter, ApplyEvent types | [Phase 6](../docs/architecture/06-automation-engine.md) |
| [`platform-adapters/`](./platform-adapters) | One folder per platform; implements `PlatformAdapter` | [Phase 2 §5](../docs/architecture/02-folder-structure.md#5-the-packagesplatform-adapters-shape) |
| [`queue/`](./queue) | BullMQ wrappers, queue names, DLQ helpers | [Phase 4 §5.2](../docs/architecture/04-backend-design.md#52-orchestrator--workers-via-bullmq-not-http) |
| [`realtime/`](./realtime) | Socket.IO server + client conventions; `useRealtime` hook | [Phase 5 §6](../docs/architecture/05-frontend-design.md#6-real-time-ux) |
| [`ui/`](./ui) | Shared React components (design system) — Radix beneath, custom skin | [Phase 5 §3](../docs/architecture/05-frontend-design.md#3-design-system) |
| [`ui-icons/`](./ui-icons) | Custom icon set | [Phase 5 §3.1](../docs/architecture/05-frontend-design.md#31-visual-identity) |
| [`testing/`](./testing) | Test fixtures, factories, MSW handlers | [Phase 4 §9](../docs/architecture/04-backend-design.md#9-testing-strategy) |

Cross-package import rules are enforced by [`tools/lint-rules`](../tools/lint-rules).
