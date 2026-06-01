# `docs/`

| Folder | Purpose |
| --- | --- |
| [`architecture/`](./architecture) | The 10 phase documents + overview & decision log |
| **[`audit/`](./audit)** | **Post-design audit + corrections** — supersedes `architecture/` wherever they conflict. Read before implementation. |
| [`adr/`](./adr) | Architecture Decision Records (numbered; one decision per file) |
| [`runbooks/`](./runbooks) | On-call procedures (filled M9) |
| [`prompts/`](./prompts) | Frozen prompt versions mirrored from `packages/ai-core/prompts` |
| [`api/`](./api) | OpenAPI YAML (generated) + handwritten API guides |

Read order for a new contributor: `audit/00-overview.md` → `architecture/00-overview.md` → `architecture/01-system-architecture.md` → continue through Phase 10, consulting `audit/01-architecture-validation.md` for corrections.
