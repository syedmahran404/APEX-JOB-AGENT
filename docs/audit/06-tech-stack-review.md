# Audit Step 6 — Tech Stack Review

This is the disciplined re-validation of every load-bearing technology choice. Each entry follows the same shape:

- **Why selected** — the specific job we picked it for.
- **Alternatives considered** — what we looked at and rejected.
- **Pros** — what makes it the right pick today.
- **Cons** — the real costs we're paying.
- **Scalability impact** — how it behaves as load grows.

A choice survives this review if its pros remain decisive at our scale (single-tenant today, multi-tenant at Phase 8, beta-load at launch). Where the audit changed our mind, the new selection is named and the rationale recorded.

---

## 1. Language & runtime

### 1.1 TypeScript (strict)

- **Why selected.** Single language across web, API, orchestrator, AI service, workers, scheduler. Zod schemas are shared end-to-end. `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` catch a class of bugs that would otherwise reach production.
- **Alternatives considered.**
  - **Polyglot (Python AI + Node web).** Rejected: two CI pipelines, two type systems, glue cost.
  - **Go for backend.** Rejected: ecosystem mismatch with Playwright; sharing types with TS frontend would require generated bindings.
  - **Rust for workers.** Rejected for the same Playwright reason; revisit only if a hot path proves CPU-bound (none has).
- **Pros.** Mature ecosystem; first-class Zod; first-class Playwright; great DX; the project's hottest paths are I/O-bound, not CPU-bound.
- **Cons.** Memory footprint per process is higher than Go. Build times require care (mitigated by Turborepo caching). `verbatimModuleSyntax` requires explicit `import type` discipline.
- **Scalability impact.** None at our scale. We will run into Node memory before TS adds friction; mitigations are in `apps/automation-worker` (memory governor) and standard `--max-old-space-size` tuning.

### 1.2 Node.js 20 LTS

- **Why selected.** LTS through April 2026; native ESM stable; native test runner adequate as a fallback; great undici/HTTP performance.
- **Alternatives considered.**
  - **Bun.** Rejected: compatibility surface still maturing; we need predictability for long-running services.
  - **Deno.** Rejected: ecosystem smaller; npm interop better but not seamless; team familiarity lower.
- **Pros.** Stable, well-instrumented, AbortController-pervasive, fetch-stable.
- **Cons.** Single-threaded event loop demands discipline at high RPS (worker_threads only when proven necessary).
- **Scalability impact.** Beyond ~5k RPS per replica, we add replicas, not threads. We aren't close.

---

## 2. Backend framework

### 2.1 NestJS + Fastify adapter

- **Why selected.** Modular boundaries via DI; guards/pipes/interceptors map cleanly to our cross-cutting concerns (auth, validation, idempotency, rate limiting, tracing). Fastify adapter keeps RPS budget healthy (~3× Express).
- **Alternatives considered.**
  - **Bare Fastify.** Rejected: re-implement DI, modules, decorators we'd want anyway.
  - **Hono.** Rejected for the same reason; ergonomics of small APIs do not translate to a service of this size.
  - **Express + handler-by-handler organization.** Rejected: no module isolation; tests become integration-by-default.
- **Pros.** Strong opinions where we want them, weak opinions where we don't. Easy to onboard.
- **Cons.** A bit more ceremony than minimal frameworks. Some Nest-isms (decorators, metadata) are foreign to Node generalists; mitigated with a one-page house-style doc.
- **Scalability impact.** None at our scale. Stateless replicas behind ingress.

### 2.2 Prisma ORM

- **Why selected.** Type-safe; well-supported; migration tooling is mature. Pairs with our PG extensions (with raw-SQL escape hatch).
- **Alternatives considered.**
  - **Drizzle.** Rejected at decision time for less mature pgvector support and schema-as-TS friction; we will revisit at Phase 4 if its pgvector story has matured.
  - **TypeORM.** Rejected: legacy decorator pain; less consistent type inference.
  - **Knex + handwritten types.** Rejected: every team that takes this path eventually rebuilds Prisma.
- **Pros.** Generated types align with the schema; queries are readable; transactions clean; good migration discipline.
- **Cons.** `findMany` with deep relations can issue N+1 queries if not careful. Prisma's relation engine has memory cost. Some advanced PG features need raw SQL (we use `prisma migrate` raw-append for extensions).
- **Scalability impact.** Connection pool management matters. PgBouncer transaction-mode for the API and orchestrator; session-mode for the AI service (which sets `SET LOCAL`). These are documented in Phase 9 §6.

---

## 3. Database

### 3.1 PostgreSQL 16

- **Why selected.** Real relational integrity; first-class JSONB; mature partitioning; pgvector extension; pg_partman; pg_trgm; pgcrypto; rich audit-friendly ergonomics. One system to run.
- **Alternatives considered.**
  - **MongoDB.** Rejected: weak relational semantics for an audit-heavy domain. Compromises (transactions, joins) erode the supposed flexibility win.
  - **CockroachDB.** Rejected: distribution we don't need; PG with read replicas covers us through Phase 8.
  - **Neon / Supabase / managed PG variants.** Used as deploy targets — not architectural alternatives. We are PG-native.
- **Pros.** Maturity, ecosystem, extensions (pgvector, pg_partman, pg_trgm), strict typing, rich PL/pgSQL for triggers (audit hash chain).
- **Cons.** Vertical-scale ceiling exists (we accept it; partitioning + read replicas + eventually shard at Phase 8+).
- **Scalability impact.** Vertical to ~50k active users, then partition the heavy tables, then add read replicas, then shard. The schema is built for this gradient.

### 3.2 pgvector + HNSW (high-churn) + IVFFlat (slow-churn)

- **Why selected (post-audit).** Audit fix D2 split index strategy: HNSW for `qa_memory` and `frequent_answers` (incremental, no rebuild required) and IVFFlat for `jobs`/`experiences`/`projects` (cheaper to insert, fine recall after periodic re-index).
- **Alternatives considered.**
  - **Pinecone / Qdrant / Weaviate.** Rejected: extra system to operate, extra failure mode, extra cost. Justified only at billions of vectors; we operate in millions.
  - **IVFFlat across the board (original Phase 3 choice).** Rejected post-audit: recall degrades on high-churn corpora.
  - **HNSW everywhere.** Rejected: ~2× index build time and ~30% more storage; not worth it for slow-churn corpora that index quarterly.
- **Pros.** One system; first-class indexes; adequate recall.
- **Cons.** Vector-aware query planning is still Postgres-y; we use explicit `ORDER BY ... <=> $vec LIMIT k` and don't try to be clever.
- **Scalability impact.** HNSW grows with `m` and `ef_construction`; we keep `m=16, ef_construction=64` (balanced). At 50M vectors per dim per tenant, latencies stay sub-50ms p95.

### 3.3 Redis (BullMQ + cache + pub/sub + rate limits)

- **Why selected.** One system covers queues, cache, pub/sub, atomic counters. Operationally cheap.
- **Alternatives considered.**
  - **NATS / Kafka.** Rejected: more infra to operate, premature complexity. Revisit at multi-tenant analytics scale.
  - **Postgres-backed queues only.** Rejected: BullMQ's semantics (delayed jobs, repeatable jobs, stalled detection, DLQ) would all be reimplemented.
- **Pros.** Mature, ubiquitous, well-instrumented, fits Node ecosystem.
- **Cons.** Persistence is best-effort (AOF every-second) — fine for our model because durability lives in PG (transactional outbox). Cluster mode adds operational nuance.
- **Scalability impact.** We split into two logical Redis instances (queues vs cache+pubsub) at Phase 4 to isolate failure modes; both are managed (ElastiCache / Memorystore / Upstash) in hosted prod.

### 3.4 Object storage (S3 / R2 / MinIO)

- **Why selected.** Versioning, lifecycle, server-side encryption with our KMS keys, presigned URLs.
- **Alternatives considered.**
  - **DB blob storage.** Rejected: kills PG performance; obvious anti-pattern.
  - **GCS / Azure Blob.** Functionally equivalent; choice is per-deploy.
- **Pros.** Cheap, durable (11 nines), versioning for resumes.
- **Cons.** Object listings are slow; we never list as a hot path.
- **Scalability impact.** Effectively unbounded; egress cost is the consideration (mitigated by lifecycle to glacier).

---

## 4. Frontend

### 4.1 React 18 + Vite

- **Why selected.** Mature ecosystem, concurrent rendering, Suspense, TanStack Query/Table, Radix, Framer Motion, R3F. Vite is the fastest dev loop.
- **Alternatives considered.**
  - **Next.js.** Rejected: SSR not needed; the streaming-job UX is awkward inside a request lifecycle.
  - **Solid / Svelte.** Rejected: smaller ecosystems for the 3D / animation libraries we want; team velocity lower.
  - **Remix.** Rejected: SSR-first; we are an authenticated cockpit.
- **Pros.** Best-in-class libraries; deep talent pool; concurrent rendering primitives map cleanly to our real-time needs.
- **Cons.** Bundle discipline matters (mitigated by Lighthouse CI + baseline pinning per audit fix E3). React's mental model has well-known gotchas (effects, refs).
- **Scalability impact. ** Frontend scaling is per-user; tools are at "beyond our scale" already.

### 4.2 Tailwind CSS + Radix UI primitives + custom design system

- **Why selected.** Tailwind for speed and consistency; Radix for accessibility-correct primitives; our own component layer for visual identity. The combination is "headless behavior + bespoke skin."
- **Alternatives considered.**
  - **Mantine / Chakra / shadcn/ui.** Rejected: all are great kits, but we want an identity, not a template.
  - **Pure CSS.** Rejected: convention cost too high at our component count.
- **Pros.** Accessibility correctness for free; styling discipline via tokens; no styled-components runtime; design system can evolve without breaking primitives.
- **Cons.** Tailwind class strings can grow long; mitigated by component composition. Inline styles for runtime tokens require a CSP nonce path (audit fix F4).
- **Scalability impact. ** None.

### 4.3 TanStack Query (server state) + Zustand (UI state)

- **Why selected.** Two complementary tools. TanStack Query handles caching/retries/devtools for server data; Zustand handles ephemeral UI state without ceremony.
- **Alternatives considered.**
  - **Redux Toolkit.** Rejected: heavier ceremony for our needs; the boilerplate doesn't pay back.
  - **Recoil.** Rejected: maintenance signals weak.
  - **SWR.** Rejected: TanStack Query has a richer feature set we use (mutation, infinite queries, devtools).
- **Pros.** Reactive without complexity; clean separation; great DX.
- **Cons.** Two libraries instead of one; mitigated by clear ownership rules.
- **Scalability impact. ** None.

### 4.4 Framer Motion + R3F (sparingly)

- **Why selected.** Motion is communication; the cockpit benefits from clear state transitions and one or two premium moments.
- **Alternatives considered.**
  - **Pure CSS animations.** Rejected: spring physics and layout transitions are awkward without Framer.
  - **GSAP.** Rejected: license, ecosystem fit weaker than Framer in React.
- **Pros.** Reduced-motion respected by both; clean lifecycle.
- **Cons.** R3F is heavy; lazy-loaded only on Command Center (audit fix E4 ensures clean disposal).
- **Scalability impact. ** None at our user scale.

---

## 5. AI

### 5.1 Anthropic Claude (Opus / Sonnet / Haiku tiers) — primary

- **Why selected.** Strong reasoning at the Opus tier; cost-effective Sonnet/Haiku; good system-prompt discipline; structured-output JSON support.
- **Alternatives considered.**
  - **OpenAI (GPT-4.1, o-class, 4o-mini).** Used as backup ladder; not primary.
  - **Open-source models (Llama, Mixtral) self-hosted.** Rejected for hosted prod (operational cost); will be considered for a self-host "BYOM" mode in a future phase.
  - **Vertex AI (Gemini).** Rejected today; the gateway abstraction makes adding providers a config change.
- **Pros.** Quality on hard reasoning (resume tailor, profile review); good cost dynamics; consistent JSON outputs with low temperature.
- **Cons.** Single-vendor risk if used alone; mitigated by the gateway's fallback ladder and `MOCK` provider for dev/CI.
- **Scalability impact. ** Cost is the gradient. Cost governor (audit fix B1 atomic) and tier routing carry the weight.

### 5.2 Embedding model — default Voyage 2 (1024 dim)

- **Why selected.** Strong recall on professional/HR domain; competitive cost; predictable.
- **Alternatives considered.**
  - **OpenAI text-embedding-3-large (3072 dim).** Higher quality on some sets; costlier; we keep an `embeddings_3072` table ready (audit fix A2).
  - **Local embedding models.** Lower-quality at our budget; revisit for self-host.
- **Pros.** Single embedding call cost is small; recall consistent.
- **Cons.** Vendor dependency; mitigated by the dim-split tables that allow swap-in.
- **Scalability impact. ** Embedding throughput is rarely the bottleneck; we batch where supported.

### 5.3 Eval harness (in-repo) over LangSmith / PromptLayer

- **Why selected.** Tight coupling to our DB (`ai_eval_results`), our schema, our CI gating. Vendor SaaS would require duplicating the schema and adding a third-party in the prompt path.
- **Alternatives considered.**
  - **LangSmith.** Rejected: another vendor; schema duplication; weak fit with our Zod-validated outputs.
  - **PromptLayer.** Same.
- **Pros.** First-class CI gate; fully observable; runs in `MOCK` mode for free.
- **Cons.** We maintain it; offset by its small surface (a few hundred lines of TypeScript).
- **Scalability impact. ** Linear in test suite size; fine.

---

## 6. Automation

### 6.1 Playwright (Chromium primary)

- **Why selected.** Best ergonomics, parallel contexts, mature network/route control, first-class headed/headless, persistent context support.
- **Alternatives considered.**
  - **Puppeteer.** Rejected: fewer features, Chromium-only, smaller momentum.
  - **Selenium.** Rejected: slower, brittle, fewer modern primitives.
  - **Browserless / Browserbase SaaS.** Rejected for hosted prod (cost + isolation control); revisit at Phase 8 if ops burden warrants.
- **Pros.** Persistent contexts, network interception, video/screenshot, CDP access for the remote viewer (Phase 7).
- **Cons.** Memory footprint per context; mitigated by audit fix C7 memory governor and pool eviction.
- **Scalability impact. ** Linear in active contexts. Worker node-pool autoscales by queue depth (KEDA).

### 6.2 `playwright-extra` + stealth

- **Why selected.** Standard fingerprint corrections out of the box; we add our own overlay (`packages/automation-core/hardening/`).
- **Alternatives considered.**
  - **Hand-roll stealth.** Rejected: maintenance burden; established library does most of the boring work.
- **Pros.** Mature, frequently updated.
- **Cons.** A leak in the stealth library can affect everyone. Mitigation: pinned version + nightly canary detects regressions across all platforms.
- **Scalability impact. ** None.

---

## 7. Observability

### 7.1 OpenTelemetry → Tempo (traces) + Loki (logs) + Prometheus (metrics) + Grafana

- **Why selected.** Open standards; self-hostable; one query language story; good Helm-charted defaults.
- **Alternatives considered.**
  - **Datadog.** Rejected: cost at our event volume; vendor lock.
  - **ELK.** Rejected: heavier to operate; weaker trace primitives.
  - **New Relic / Honeycomb.** Considered for traces specifically; revisit if Tempo proves insufficient (currently does not).
- **Pros.** Open, integrated, fits self-host story.
- **Cons.** More infra than a SaaS would require; mitigated by a tight, opinionated Helm chart.
- **Scalability impact. ** Loki/Tempo backed by object storage scales effectively unbounded; Prometheus is sized per cluster.

### 7.2 Sentry for error tracking

- **Why selected.** Best-in-class error capture, source-map handling, release tracking, breadcrumb correlation.
- **Alternatives considered.**
  - **Custom error-event pipeline through Loki.** Rejected: less ergonomic, no aggregation by fingerprint.
- **Pros.** Free of charge below thresholds; very low integration cost; trace-id correlation.
- **Cons.** Vendor; we accept because the value is high and the data is non-sensitive (we redact PII before send).
- **Scalability impact. ** Within Sentry's normal usage curves.

---

## 8. Security infrastructure

### 8.1 HashiCorp Vault (Transit + PKI + Database secrets)

- **Why selected.** First-class envelope crypto, lease+redeem semantics, dynamic database creds, PKI for internal mTLS, mature audit log.
- **Alternatives considered.**
  - **AWS KMS only.** Rejected: locks to AWS; we want self-host parity.
  - **GCP KMS only.** Same.
  - **Plain libsodium files with a custom rotation story.** Rejected: rotation is the hardest part; Vault solves it.
- **Pros.** Mature, well-documented, ubiquitous; dev profile available for local; production HA cluster for hosted prod; production-mode file storage for self-host (audit fix F1).
- **Cons.** HA cluster operationally non-trivial. We mitigate by paying for managed (Cloud HSM-backed where available) and by running **single-node production-mode** in self-host (Shamir-split unseal recovery — audit fix G2).
- **Scalability impact. ** Wrap/unwrap throughput far exceeds our needs.

### 8.2 Lucia / `@simplewebauthn` for WebAuthn

- **Why selected.** Open, framework-agnostic; clean integration with our session model; no third-party dependency for the most sensitive flow.
- **Alternatives considered.**
  - **Auth0 / Clerk / WorkOS.** Rejected: the auth flow binds tightly to our credential vault; outsourcing would require sharing the binding step with a vendor.
  - **NextAuth / Auth.js.** Rejected: opinionated for Next; fights our session-DEK binding.
- **Pros.** Full control, easy to audit, compliant with WebAuthn spec.
- **Cons.** We own bug surface; mitigated by `@simplewebauthn`'s test suite + our two-reviewer rule.
- **Scalability impact. ** None; auth path is rare.

### 8.3 Linkerd service mesh

- **Why selected.** Smaller blast radius than Istio in failure modes; mTLS automatic; SPIFFE identities clean; lightweight sidecar (Rust).
- **Alternatives considered.**
  - **Istio.** Rejected: heavier; we don't need its advanced routing today.
  - **Cilium service mesh.** Considered; revisit if eBPF benefits become decisive.
  - **No mesh; ingress-only TLS.** Rejected: internal mTLS is non-negotiable for credential traffic.
- **Pros.** Easy onboarding; good defaults.
- **Cons.** We exclude workers' egress to platform domains from the mesh (mTLS would interfere with TLS to third parties — Phase 9 §7.2).
- **Scalability impact. ** Per-pod sidecar overhead modest.

---

## 9. Build & CI

### 9.1 pnpm + Turborepo

- **Why selected.** Strict dependency isolation (no accidental hoisting); lockfile correctness; build-task graph caching.
- **Alternatives considered.**
  - **Nx.** Rejected: more opinionated; learning curve mismatch with team.
  - **Yarn Berry.** Rejected: PnP friction; pnpm is enough.
  - **npm workspaces.** Rejected: lockfile + hoisting issues over time.
- **Pros.** Fast, predictable, well-documented.
- **Cons.** Engineers occasionally hit pnpm-specific symlink quirks; documented in CONTRIBUTING (added M0).
- **Scalability impact. ** Repo-scale; we are far from any threshold.

### 9.2 GitHub Actions

- **Why selected.** Tight integration with the repo; runner ecosystem; OIDC for cosign keyless signing.
- **Alternatives considered.**
  - **CircleCI / Buildkite.** Rejected: extra vendor; GH Actions is sufficient.
  - **Self-hosted runners only.** Rejected initially; revisit at Phase 8 if cost or speed warrants.
- **Pros.** Native PR integration; OIDC; large ecosystem.
- **Cons.** Minute consumption can grow; mitigated by Turborepo cache + careful job scoping.
- **Scalability impact. ** Linear in build size; fine through Phase 8.

---

## 10. Deployment

### 10.1 Kubernetes + Helm + ArgoCD

- **Why selected.** Standard, portable, declarative; ArgoCD GitOps pairs cleanly with image-digest-pinned releases (cosign-verified at admission).
- **Alternatives considered.**
  - **Nomad.** Rejected: smaller ecosystem; less integrated mesh story.
  - **ECS / Cloud Run.** Rejected: vendor lock; doesn't suit self-host.
  - **Fly.io / Railway.** Considered for self-host single-tenant; revisit only as a "managed self-host" offering.
- **Pros.** Industry-standard, observable, Helm makes the chart portable.
- **Cons.** k8s itself is a platform to learn; mitigated by managed control plane (EKS/GKE/AKS) and a tight chart.
- **Scalability impact. ** Cluster autoscaler + KEDA cover it.

### 10.2 Terraform (modules + per-env)

- **Why selected.** Standard for cloud infra; modules promote reuse; per-env state isolates blast radius.
- **Alternatives considered.**
  - **Pulumi.** Considered; TypeScript-native is appealing but the team's Terraform familiarity is higher; switching cost not justified yet.
  - **CDK (cloud-native).** Rejected: vendor-specific; doesn't fit self-host.
- **Pros.** Industry standard; battle-tested.
- **Cons.** State management nuance; mitigated by remote backend + locks.
- **Scalability impact. ** Per-env scales linearly; we plan for 2 envs (staging, prod).

---

## 11. Email & inbound mail

### 11.1 SES + S3 + SNS (inbound) / Postmark (transactional)

- **Why selected (post-audit).** Inbound email ingestion (missing feature §3) needs cheap MIME storage + reliable trigger; SES + S3 + SNS is the canonical AWS pattern. Postmark is best-in-class for transactional outbound deliverability and templates.
- **Alternatives considered.**
  - **Mailgun (inbound + outbound).** Considered; deliverability good, costs slightly higher.
  - **Self-hosted (Postfix + Dovecot + custom).** Rejected for hosted prod; possible self-host extension.
- **Pros.** Each picked for its strength rather than a one-vendor compromise.
- **Cons.** Two vendors; mitigated by `packages/email` provider abstraction.
- **Scalability impact. ** Within both vendors' normal curves.

---

## 12. Testing

### 12.1 Vitest (unit + integration)

- **Why selected.** Fast, ESM-native, Vite-aligned; same expectations on web and Node.
- **Alternatives considered.**
  - **Jest.** Rejected: ESM friction; slower; heavier.
  - **Node test runner.** Considered as a fallback; insufficient for our complex needs.
- **Pros.** Fast, modern, plays well with monorepo.
- **Cons.** Newer than Jest; we accept; community + maintainers strong.
- **Scalability impact. ** Linear in test count; Turborepo caches across packages.

### 12.2 Playwright (e2e + adapter offline tests)

- **Why selected.** One tool for both e2e against the web app and adapter offline tests against fixtures.
- **Alternatives considered.**
  - **Cypress.** Rejected for adapter offline; we need full Playwright capability anyway.
- **Pros.** Single test toolchain.
- **Cons.** Browser binaries are large; cached in CI.
- **Scalability impact. ** Independent jobs; parallelizable.

### 12.3 Testcontainers + Docker Compose (e2e stack)

- **Why selected.** Hermetic stacks for integration and e2e; works in CI and on a developer laptop.
- **Alternatives considered.**
  - **Mocking everything.** Rejected: too many false positives; we need real PG, real Redis, real Vault.
  - **Shared staging databases.** Rejected: tests must be hermetic.
- **Pros.** Reproducible; fast on warm caches.
- **Cons.** Requires Docker. We accept.
- **Scalability impact. ** Bound by CI runner resources; matrix splits as suites grow.

---

## 13. Outcomes from this review

- **No replacement, only refinement.** The original architecture's tech choices survive. The audit changed the *configuration* of three (HNSW vs IVFFlat per corpus; Vault production-mode in self-host; Socket.IO Redis adapter mandate) and added clarity to the inbound-email choice (SES+S3+SNS or Postmark inbound, behind `packages/email`).
- **Two-vendor where it pays:** Anthropic primary + OpenAI ladder (AI), SES + Postmark (email). Single-vendor everywhere else, with abstractions in place to swap if needed.
- **No SaaS we can run ourselves at our scale:** Vault (we run it), observability stack (we run it), eval harness (we run it).
- **Self-host parity preserved.** Every choice has a self-host path: managed PG → containerized PG; SES/Postmark → SMTP; managed Redis → containerized Redis; cloud KMS → Vault file storage with Shamir.

The stack is right for the job, sized for the load, and not over-bought. A senior engineering team can begin Phase 1 against this stack immediately.
