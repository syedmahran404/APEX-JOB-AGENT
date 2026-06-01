# 00 — Architecture Overview & Decision Log

This document is the entry point. It states the non-negotiable principles, names the architectural style, lists the major decisions with their rejected alternatives, and points into the deeper phase documents.

---

## 1. Non-negotiable principles

These are the constraints every later decision must respect. If a feature contradicts one of these, the feature gets redesigned, not the principle.

1. **The user owns their data and their accounts.** Credentials are stored under envelope encryption with a per-user data key. The platform never logs in to a job site outside the user's authenticated session.
2. **No silent mutation.** Profile edits and resume edits are gated by explicit, scoped permissions. Default state is *deny*.
3. **Resumability is a first-class concern, not a recovery feature.** Every run is a state machine persisted to PostgreSQL. Killing any worker mid-flight must not duplicate, lose, or corrupt an application.
4. **Freshness drives priority.** The Application Priority Engine sorts strictly by recency tier (5h → 12h → 24h → 5d). Older listings are discarded.
5. **AI decisions are auditable.** Prompt, response, model, temperature, token cost, and a one-paragraph reasoning summary are persisted for every consequential AI call.
6. **Human-like, not human-pretending.** Anti-detection focuses on reasonable timing, viewport, and interaction realism. We do not impersonate other humans, forge identities, or evade explicit platform consent screens.
7. **Speed is a function of correctness.** Parallelism and batching are pursued only where idempotency and error isolation are proven.
8. **Observability before features.** Every new module ships with logs, metrics, and traces. A feature without telemetry is incomplete.

---

## 2. Architectural style

**Modular monolith with detachable workers**, deployed as a small set of cooperating services from day one:

- A single TypeScript codebase organized as a **pnpm + Turborepo monorepo** (see Phase 2).
- Bounded contexts have hard module boundaries enforced by ESLint import rules and dedicated `packages/*` per domain.
- Three runtime "shapes" share that codebase:
  1. **Online services** — API, AI service, analytics ingest. Stateless, horizontally scalable.
  2. **Orchestrator** — durable state machine, single-writer per run, scaled by sharding on `user_id`.
  3. **Automation workers** — heavy, browser-bound, scaled independently in their own node pool.
- Communication is asynchronous by default via Redis Streams / BullMQ. Synchronous calls are reserved for client-facing reads.

Why not microservices from day one: microservices add deployment, contract, and observability tax that we don't need until the team or the product justifies it. The modular monolith gets us 90% of the isolation benefit at 20% of the operational cost, and the boundaries we enforce in code today become service boundaries tomorrow without rewrites.

Why not a single Next.js app: server-rendered React is a fine *frontend*, but driving Playwright browsers, owning a state machine, and handling LLM cost governance from inside a Next request lifecycle is a category error. The frontend stays a focused SPA; the backend is built for long-running, durable work.

---

## 3. Major decisions (decision log)

| # | Decision | Chosen | Rejected (and why) |
| --- | --- | --- | --- |
| D-01 | Language | TypeScript end-to-end | Polyglot (Python AI + Node web): too much glue, duplicate types, two CI pipelines. Python anywhere needed gets called as a sidecar. |
| D-02 | Web framework (backend) | NestJS (Fastify adapter) | Express: weak modularity. Bare Fastify: re-implement DI, guards, pipes. |
| D-03 | ORM | Prisma | Drizzle: less mature migrations on PG extensions (pgvector). TypeORM: legacy decorator pain. |
| D-04 | Primary DB | PostgreSQL 16 + pgvector + pg_partman | MongoDB: weak relational integrity for an audit-heavy domain. Separate vector DB (Pinecone/Qdrant): one more system to operate; pgvector is sufficient through year 1. |
| D-05 | Queue | BullMQ on Redis | Temporal: superior for long workflows but heavy to operate; revisit at M9. SQS: vendor lock. |
| D-06 | Browser automation | Playwright (Chromium primary) | Puppeteer: fewer features, Chromium-only. Selenium: slower, brittle. |
| D-07 | AI primary | Anthropic Claude (Opus tier for hard reasoning, Sonnet/Haiku tier for routine) | OpenAI-only: single-vendor risk. Multi-vendor router from day one: premature complexity, but the LLM gateway is designed to make swap-in trivial. |
| D-08 | Vector store | pgvector | Pinecone/Qdrant: extra moving part for our scale (millions of embeddings, not billions). |
| D-09 | Real-time channel | Socket.IO over WebSocket | SSE-only: harder for bidirectional commands (pause/resume). Raw WS: re-implement reconnection and rooms. |
| D-10 | Frontend stack | React 18 + Vite + TypeScript + Tailwind + Framer Motion + R3F | Next.js: SSR not needed, complicates streaming-job UI. Solid/Svelte: smaller ecosystem for the 3D/animation libraries we want. |
| D-11 | Client state | TanStack Query (server) + Zustand (UI) | Redux Toolkit: heavier ceremony for our needs. Recoil: maintenance uncertainty. |
| D-12 | Auth | Self-hosted (Lucia + Argon2id) with WebAuthn + TOTP | Auth.js: opinionated for Next; we need full control of session model and credential vault wiring. |
| D-13 | Secrets / KMS | HashiCorp Vault (prod) / age-encrypted local Vault dev profile | AWS KMS only: locks us to AWS. Plain libsodium files: no rotation story. |
| D-14 | Object storage | S3-compatible (MinIO local, AWS S3 / R2 prod) | DB-blob: kills PG performance for screenshots. |
| D-15 | Observability | OpenTelemetry → Tempo (traces), Loki (logs), Prometheus (metrics), Grafana | Datadog: cost. ELK: heavier, fewer trace primitives. |
| D-16 | Container orchestration | Kubernetes for prod; Docker Compose for self-host & dev | Nomad: smaller ecosystem. ECS: AWS lock-in. |
| D-17 | Browser worker isolation | One Linux user namespace + one persistent Playwright context per (user, platform) | Single shared browser: cross-account leakage risk. Fresh browser every time: defeats anti-detection (cookies/fingerprint churn). |
| D-18 | Schema validation | Zod everywhere (DTOs, env, AI structured outputs) | Joi/Yup: weaker TS inference. Class-validator: duplicates Zod's job. |
| D-19 | Migrations | Prisma Migrate + hand-written SQL for extensions | Pure SQL with sqitch: more correct but slower iteration. |
| D-20 | Multi-tenancy | Single-tenant per deployment in M0–M8; row-level multi-tenancy with `tenant_id` + RLS planned for M9 | Multi-tenant from day one: scope creep, security blast radius. |

Each entry has a longer rationale in the relevant phase document.

---

## 4. The end-to-end happy path (one paragraph, no diagrams)

The user signs in with WebAuthn, completes the onboarding wizard (resume parse, personal facts, preferences, frequently used answers), and connects each platform account by entering credentials into the vault UI; the credentials are sealed with the user's data key the moment they hit the API and are never visible again. The user picks a mode (Single or Multi-Platform) and a target (default 20 applications per platform), confirms permission scopes, and clicks Run. The Orchestrator persists a run record, breaks the work into per-platform stages, and pushes platform tasks onto BullMQ. Each Automation Worker pulls a task, restores its persistent Playwright context for that (user, platform) pair, opens the search surface, and emits a stream of candidate jobs to the AI service, which scores them 0–100 and stamps a freshness tier. Jobs at or above the user's threshold and within the freshness window queue into the Apply pipeline, where the worker fills the form, calls the AI Q&A service for each non-trivial field (answers come from RAG over the user's knowledge base, validated against zod schemas, and consistent with prior answers), uploads the chosen resume version, and submits. Every step writes to the application timeline, every screenshot lands in object storage, every AI call lands in the decision log, and the frontend's command center sees it all live over Socket.IO. If the worker hits a CAPTCHA or OTP, mode-A pauses the run and notifies the user; mode-B records "skipped: human verification required" and moves on. When the user pauses, stops, or kills the process, the orchestrator finishes the in-flight application atomically and marks the next task `pending`; on resume, it picks up exactly there.

---

## 5. Where to read next

> **Audit:** A comprehensive post-design audit lives at [`../audit/`](../audit). It corrects ~30 issues in this folder (4 S1 blockers, 16 S2 material findings, ~18 refinements), adds 20 missing enterprise features (most notably a scheduler service, webhooks, email ingestion, dry-run mode, job dedupe, consented impersonation), revises the database schema to ~74 tables, and gives a numerical 10/100/1000-applications-per-day capacity model. **Read [`../audit/00-overview.md`](../audit/00-overview.md) before starting Phase 1.** Where the audit contradicts a phase doc, the audit wins.

- For the *shape* of the system: [Phase 1 — System Architecture](./01-system-architecture.md).
- For the *layout* of the code: [Phase 2 — Folder Structure](./02-folder-structure.md).
- For *what the database holds*: [Phase 3 — Database Design](./03-database-design.md).
- For *how the backend behaves*: [Phase 4 — Backend Design](./04-backend-design.md).
- For *how the UI feels*: [Phase 5 — Frontend Design](./05-frontend-design.md).
- For *how the browser work happens*: [Phase 6 — Automation Engine](./06-automation-engine.md).
- For *how the AI thinks*: [Phase 7 — AI Engine](./07-ai-engine.md).
- For *how it stays safe*: [Phase 8 — Security Architecture](./08-security-architecture.md).
- For *how it ships*: [Phase 9 — Deployment Architecture](./09-deployment-architecture.md).
- For *how we get there*: [Phase 10 — Implementation Roadmap](./10-implementation-roadmap.md).
