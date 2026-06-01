# `apps/`

Deployable processes. One folder per process. Each is a separate workspace package; cross-app imports are forbidden by the `apex/no-cross-app-imports` ESLint rule.

| App | Role | Phase reference |
| --- | --- | --- |
| [`web/`](./web) | React 18 SPA cockpit | [Phase 5](../docs/architecture/05-frontend-design.md) |
| [`api/`](./api) | NestJS API gateway / BFF | [Phase 4 §3](../docs/architecture/04-backend-design.md#3-the-api-gateway-appsapi) |
| [`orchestrator/`](./orchestrator) | Run state machine, single-writer for run/application status | [Phase 4 §4](../docs/architecture/04-backend-design.md#4-the-orchestrator-appsorchestrator) |
| [`ai-service/`](./ai-service) | LLM gateway, RAG, prompt registry, decision audit, cost governor | [Phase 7](../docs/architecture/07-ai-engine.md) |
| [`automation-worker/`](./automation-worker) | Playwright workers; one task at a time per `(user, platform)` | [Phase 6](../docs/architecture/06-automation-engine.md) |
| [`analytics/`](./analytics) | Event ingest + rollups | [Phase 1 §2.6](../docs/architecture/01-system-architecture.md#26-analytics-service-appsanalytics) |

Internal shape (per [Phase 2 §4](../docs/architecture/02-folder-structure.md#4-the-apps-contract)):

```
apps/<name>/
├── src/
│   ├── main.ts
│   ├── app.module.ts            # NestJS apps only
│   ├── modules/<module>/...
│   ├── infra/
│   └── config/
├── test/
├── Dockerfile
├── package.json
├── tsconfig.json                # extends ../../tsconfig.base.json
└── README.md
```
