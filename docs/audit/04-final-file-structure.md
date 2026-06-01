# Audit Step 4 — Final Production-Ready File Structure

This is the final layout after the audit. The original structure from [`docs/architecture/02-folder-structure.md`](../architecture/02-folder-structure.md) is **mostly correct**; this document captures the deltas:

- One new app: `apps/scheduler` (missing feature §1).
- One new app: `apps/remote-viewer` (Phase 7).
- Email ingestion is a module inside `apps/automation-worker` rather than a separate app (decision in audit; one fewer service to operate).
- New shared packages: `packages/feature-flags`, `packages/email`, `packages/webhooks`.
- Sub-folders inside existing packages to host audit-driven additions.

The layout is organized by clean-architecture concerns the user named — **Backend, Frontend, AI Engine, Automation Engine, Analytics Engine, Security Layer, Database Layer, Shared Libraries, Testing Infrastructure** — with a mapping table at the end so each concern points to its owning folder(s).

---

## Top-level layout (final)

```text
apex-job-agent/
├── apps/                                # Deployable processes
│   ├── web/                             # React 18 SPA cockpit
│   ├── api/                             # NestJS API gateway / BFF
│   ├── orchestrator/                    # Run state machine (single writer per user)
│   ├── ai-service/                      # LLM gateway + RAG + governor + audit
│   ├── automation-worker/               # Playwright workers + email-ingest module
│   ├── analytics/                       # Event ingest + rollups + cost attribution
│   ├── scheduler/                       # NEW: cron + leader election + maintenance + recurring runs
│   └── remote-viewer/                   # NEW (Phase 7): consented browser-tab streaming
│
├── packages/                            # Shared libraries (no processes)
│   ├── shared-types/                    # Zod schemas + inferred TS types (single source of truth)
│   ├── shared-config/                   # Validated env + feature-flag loader
│   ├── shared-logger/                   # Pino + OTel + PII redaction defaults
│   ├── shared-errors/                   # Typed error hierarchy
│   ├── shared-events/                   # Event names + payload schemas + state-machine reducers
│   ├── db/                              # Prisma schema + migrations + repositories + outbox + DEK helpers
│   ├── crypto/                          # Envelope encryption (AES-256-GCM + AAD + HKDF subkeys)
│   ├── vault-client/                    # Vault SDK wrapper + lease/redeem helpers
│   ├── ai-core/                         # Prompt registry + provider abstraction + eval + calibration + style
│   ├── automation-core/                 # Browser pool + anti-detection + ATS detector + base adapter + memory governor
│   ├── platform-adapters/               # Per-platform: linkedin, naukri, indeed, internshala, glassdoor, foundit, wellfound, upwork
│   ├── queue/                           # BullMQ wrappers + queue-name catalog + DLQ helpers
│   ├── realtime/                        # Socket.IO server + Redis adapter + client conventions + useRealtime hook
│   ├── feature-flags/                   # NEW: flag evaluation + experiment bucketing
│   ├── email/                           # NEW: provider abstraction + templates + suppression list
│   ├── webhooks/                        # NEW: HMAC signing + delivery semantics + replay protection
│   ├── ui/                              # Shared React components (design system; Radix-headless beneath)
│   ├── ui-icons/                        # Custom icon set
│   └── testing/                         # Test fixtures + factories + MSW handlers + Testcontainers helpers
│
├── infra/
│   ├── docker/                          # Multi-stage Dockerfiles per app
│   ├── compose/                         # dev / e2e / selfhost stacks
│   ├── k8s/                             # Helm chart + per-env values
│   ├── terraform/                       # Modules + per-env state
│   ├── otel/                            # Collector + Grafana dashboards + Alertmanager rules + proxy log pipeline
│   └── scripts/                         # Idempotent ops scripts (DR, rotation, scrubbing)
│
├── docs/
│   ├── architecture/                    # Original 10 phase docs (canonical design)
│   ├── audit/                           # THIS folder: post-design audit + corrections
│   ├── adr/                             # Architecture Decision Records (one file per decision)
│   ├── api/                             # OpenAPI YAML (generated) + handwritten guides
│   ├── prompts/                         # Frozen mirrors of packages/ai-core/prompts/
│   └── runbooks/                        # On-call procedures (filled in Phase 8)
│
├── tools/
│   ├── codegen/                         # OpenAPI → typed web SDK; Prisma → Zod helpers
│   ├── lint-rules/                      # Custom ESLint rules enforcing monorepo boundaries
│   ├── eval-harness/                    # AI eval runner; gates merges to packages/ai-core/prompts/**
│   └── db-scrub/                        # NEW: PII scrub manifest + runner for staging refreshes
│
├── .changeset/                          # Internal package versioning
├── .github/workflows/                   # CI/CD: ci, e2e, prompt-eval, adapter-canary, release, codeql
├── .editorconfig
├── .env.example
├── .gitignore
├── .nvmrc
├── .prettierrc.cjs
├── CODEOWNERS                           # Two-reviewer rule on auth/crypto/migrations/AI prompts
├── README.md
├── eslint.config.js                     # Flat config; references tools/lint-rules
├── package.json                         # Root: pnpm scripts + devDeps only
├── pnpm-workspace.yaml
├── tsconfig.base.json                   # Strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess
└── turbo.json
```

---

## New service: `apps/scheduler`

```text
apps/scheduler/
├── src/
│   ├── main.ts                          # Bootstrap; pg_advisory_lock leader election
│   ├── leader/                          # Leader-election lifecycle
│   ├── jobs/
│   │   ├── system/
│   │   │   ├── partitions-rollover.ts   # pg_partman maintenance
│   │   │   ├── analytics-rollups.ts     # Refresh continuous aggregates
│   │   │   ├── audit-chain-verify.ts    # Daily verifier
│   │   │   ├── idempotency-reaper.ts    # Reap expired idempotency_keys
│   │   │   ├── embedding-refresh.ts     # Drain embedding_refresh_queue
│   │   │   ├── ai-calibration.ts        # Score → outcome calibration
│   │   │   ├── adapter-canary.ts        # Read-only discovery against real sites
│   │   │   ├── selector-drift-sweep.ts  # Detect adapter regressions
│   │   │   ├── application-refresher.ts # "Second pass" status sweep
│   │   │   ├── token-bucket-reset.ts    # Daily/hourly bucket resets
│   │   │   ├── dr-drill-opener.ts       # Forces DR drill cadence (audit fix G6)
│   │   │   └── data-export-scheduler.ts # Recurring user data exports
│   │   ├── user/
│   │   │   ├── recurring-runs.ts        # User-defined cron-triggered runs
│   │   │   ├── saved-search-alerts.ts   # Discovery-only sweeps for saved queries
│   │   │   └── notification-quiet-hours.ts # Defer notifications outside quiet hours
│   │   └── security/
│   │       └── rules-engine.ts          # Drives lockouts/pauses/pages from security_events
│   ├── webhooks/
│   │   ├── delivery-worker.ts           # Outbound webhook delivery with retries + DLQ
│   │   └── signing.ts                   # HMAC envelope signing
│   ├── bulk/
│   │   └── operation-runner.ts          # Drives bulk_operations + items
│   └── infra/                           # Health, metrics, OTel
├── test/
├── Dockerfile
├── package.json
├── tsconfig.json
└── README.md
```

The scheduler is intentionally a **collection of small jobs** rather than a generic cron framework. Each job is a TypeScript function with: `id`, `cron`, `runIfLeader`, `idempotent`, `metrics`, `runbook` link.

---

## New service: `apps/remote-viewer` (Phase 7)

```text
apps/remote-viewer/
├── src/
│   ├── main.ts                          # Tiny WebSocket proxy
│   ├── auth/                            # Verifies one-time-use signed URLs (5-min TTL)
│   ├── stream/                          # CDP-over-WS stream from worker's Playwright page
│   ├── overlay/                         # Server-injected UI overlay (cancel, status)
│   └── audit/                           # Records every keystroke / click for replay
├── test/
├── Dockerfile
├── package.json
├── tsconfig.json
└── README.md
```

Runs in its own pod, in its own namespace, with the strictest egress policy in the cluster (only to the specific worker's CDP socket and to S3 for audit). One viewer per concurrent CAPTCHA.

---

## Email ingestion (module, not app)

```text
apps/automation-worker/src/email-ingest/
├── inbox.ts                             # Inbound provider (SES + S3 + SNS) handler
├── parser.ts                            # MIME parsing + attachment safety
├── classifier.ts                        # Status classifier (small AI model; opt-in)
├── matcher.ts                           # Match incoming message → applications row
└── status-writer.ts                     # Apply status update via api/internal
```

Reasoning: the worker already has the patterns (idempotency, BullMQ consumer, AI client). One fewer pod and one fewer service-mesh edge.

---

## Sub-folders added to existing packages

### `packages/automation-core/`
```
ats-detector/                            # Workday/Greenhouse/Lever/SmartRecruiters/Ashby (audit fix C6)
fingerprint/
  generator.ts                           # Per-user device profile (stable)
  rotation.ts                            # Compromise-heuristic rotation (audit fix C2)
behavior/
  paste-vs-type.ts                       # Per-field strategy (audit fix C3)
memory-governor.ts                       # Per-context RSS budget enforcement (audit fix C7)
ip-reputation/                           # Tracks per-(IP, platform) CAPTCHA density (audit fix C4)
```

### `packages/ai-core/`
```
prompts/<key>/v<N>/                      # Versioned prompts as before
providers/                               # AnthropicProvider, OpenAIProvider, MockProvider
calibration/
  cohorts.ts                             # Cohort-quarantined calibration (audit fix D5)
  isotonic.ts                            # Calibrator
governor/
  atomic-decrement.ts                    # SQL pattern for race-free reservation (audit fix B1)
safety/
  output-classifier.ts                   # Post-output PII/toxicity/injection checker (missing feature §14)
  prompt-injection-quarantine.ts         # Memory-write quarantine (audit fix D3)
style/
  banned.ts                              # Banned-phrase list
  peer-norms.json                        # Hand-curated until M9
  locales/                               # Locale-aware prompt branches
```

### `packages/db/`
```
prisma/
  schema.prisma                          # Updated per audit Step 5
  migrations/
  seed.ts
src/
  client.ts
  repositories/
    user.repository.ts
    application.repository.ts
    schedule.repository.ts               # NEW
    saved-search.repository.ts           # NEW
    webhook.repository.ts                # NEW
    bulk-op.repository.ts                # NEW
    feature-flag.repository.ts           # NEW
    support-session.repository.ts        # NEW
    cost.repository.ts                   # ai_cost_ledger atomic-decrement helper
    audit.repository.ts                  # Per-tenant chain helpers
    embeddings/                          # Sibling tables per dim (audit fix A2)
      embeddings_1024.ts
      embeddings_3072.ts
      view.ts
    outbox.repository.ts                 # outbox_events writer + relay reader
    idempotency.repository.ts            # idempotency_keys backstop
  transactions.ts                        # runInTransaction with serialization-conflict retries
  extensions/
    audit-chain.trigger.sql              # Per-tenant hash-chain trigger
```

### `apps/api/src/modules/`
Adds modules:
```
schedules/                               # CRUD + UI for recurring runs
saved-searches/                          # CRUD + alert preferences
webhooks/                                # Register/test/delete + delivery audit
bulk/                                    # Submit + status + undo
support/                                 # Consented impersonation flow
admin/                                   # Tenant + flag management (admin role only)
status/                                  # Public status page data feed
data-export/                             # On-demand + scheduled exports
```

### `apps/web/src/app/(authed)/`
Adds routes:
```
schedules/                               # Recurring runs UI
saved-searches/                          # Pinned queries + matches
webhooks/                                # Webhook config in Settings
bulk/                                    # Bulk operation progress drawer
support/                                 # User-side: review and revoke active support sessions
```

---

## Mapping: clean-architecture concerns → folders

The user named nine concerns. Each maps to its owning folder(s):

| Concern | Owning folders |
| --- | --- |
| **Backend** | `apps/api`, `apps/orchestrator`, `apps/scheduler`, `apps/analytics` |
| **Frontend** | `apps/web`, `packages/ui`, `packages/ui-icons` |
| **AI Engine** | `apps/ai-service`, `packages/ai-core`, `tools/eval-harness` |
| **Automation Engine** | `apps/automation-worker`, `apps/remote-viewer`, `packages/automation-core`, `packages/platform-adapters/*` |
| **Analytics Engine** | `apps/analytics`, `packages/db/src/repositories/cost.repository.ts`, `infra/otel/` |
| **Security Layer** | `packages/crypto`, `packages/vault-client`, `apps/api/src/modules/auth`, `apps/api/src/modules/personal-info`, `infra/k8s/` (NetworkPolicy + service mesh), `tools/db-scrub` |
| **Database Layer** | `packages/db`, `packages/shared-events` (state machines), `infra/scripts/` (DR + rotation) |
| **Shared Libraries** | `packages/shared-types`, `packages/shared-config`, `packages/shared-logger`, `packages/shared-errors`, `packages/shared-events`, `packages/queue`, `packages/realtime`, `packages/feature-flags`, `packages/email`, `packages/webhooks`, `packages/testing` |
| **Testing Infrastructure** | `packages/testing`, `tools/eval-harness`, `infra/compose/e2e.compose.yaml`, `apps/web/test/`, `tools/lint-rules/` |

The custom ESLint boundary rules in `tools/lint-rules/` are what keep the layout from decaying. Without them, "shared libraries" become "shared dumping ground" within a quarter.

---

## What this layout buys

- **One service per concern.** Easy to reason about, easy to scale independently, easy to deprecate.
- **One package per shared idea.** No `utils`, no `common`, no `helpers`. Either a package has a name and a purpose, or it doesn't exist.
- **One Zod source of truth** (`packages/shared-types`) consumed by both client and server.
- **One DB layer** (`packages/db`) — apps never touch Prisma directly.
- **One AI gateway** (`apps/ai-service`) — workers and orchestrator never address providers.
- **One realtime contract** (`packages/realtime`) — server and client agree.
- **One audit chain shape** (`packages/db/extensions/audit-chain.trigger.sql`) — multi-tenant from day one.
- **One scheduler** (`apps/scheduler`) — owns *all* time-based work.

A senior engineering team can begin **Phase 1 today** and never need to argue about which folder a thing goes in.
