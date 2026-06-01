# Phase 9 — Deployment Architecture

## 1. Goals

The deployment architecture turns the design from Phases 1–8 into something that ships, runs, recovers, and scales. It must support three deployment shapes from the same codebase, with no code forks:

1. **Local development** — single machine, Docker Compose, fast inner loop.
2. **Self-hosted** — single-tenant, single VM or small cluster, for power users who want to run the agent on their own hardware.
3. **Hosted production** — multi-tenant (M9), Kubernetes, auto-scaling, observability, full DR.

Across all three, the contract is the same: same images, same migrations, same configuration shape; only resource sizing, concurrency, and the secrets backend differ.

This phase covers: environments, image strategy, the Kubernetes topology, scaling and autoscaling, networking, CI/CD, observability, backup/DR, secrets management at deploy time, and the self-hosted profile.

## 2. Environments

| Environment | Purpose | Data | Provisioning | Promote from |
| --- | --- | --- | --- | --- |
| `dev` (local) | Engineer's machine | Synthetic seed | `infra/compose/dev.compose.yaml` | n/a |
| `e2e` (CI) | Automated end-to-end tests | Hermetic synthetic seed | `infra/compose/e2e.compose.yaml` | n/a |
| `staging` | Pre-prod soak, perf, SOC checks | Production-like, scrubbed | Terraform + Helm | `dev` |
| `prod` | User-facing | Real, encrypted | Terraform + Helm + GitOps | `staging` |
| `selfhost` | Customer-operated | Customer-controlled | `infra/compose/selfhost.compose.yaml` or single-node Helm chart | n/a |

Promotion rule: a release is identified by the immutable image digest set; staging runs the exact digest set that prod will run; nothing else is "promoted." The Helm values change, the images do not.

## 3. Image strategy

### 3.1 Build

- Multi-stage Dockerfiles per app under `infra/docker/`. Stage 1 builds with `pnpm install --frozen-lockfile` against the workspace; stage 2 copies only the relevant `dist/` and `node_modules/` slice into a minimal `node:20-bookworm-slim` (or `gcr.io/distroless/nodejs20` for non-Playwright apps).
- Playwright workers use `mcr.microsoft.com/playwright:v1.x-jammy` as the runtime base; we pin the digest, never the tag.
- Web app builds to a static `dist/` and is served by `nginx:1.27-alpine` (also digest-pinned), or via a CDN in front of an S3 origin in hosted prod.

### 3.2 Reproducibility & provenance

- Build inside a sealed CI runner with no production secrets.
- `docker buildx` with `--provenance` and `--sbom` produces a CycloneDX SBOM and SLSA-style provenance attestation per image.
- Images signed with `cosign` (Sigstore keyless using GitHub OIDC). Public key and Rekor entry checked at admission time.
- Tag strategy: every image is tagged with `git-<sha>` and `vX.Y.Z` (on releases). The `latest` tag is **not used** in any environment.

### 3.3 Registry

- Hosted prod: a private OCI registry (GitHub Container Registry or AWS ECR). Pull through service accounts; no long-lived registry credentials in pods.
- Self-hosted: customer pulls from our public mirror (image digests provided in the release notes) or builds locally.

## 4. Kubernetes topology (hosted prod)

We deploy as a single Helm chart `apex-job-agent` with subcharts per app. Values per environment live in `infra/k8s/envs/<env>.values.yaml`. The chart targets Kubernetes ≥ 1.28.

### 4.1 Namespaces

- `apex-prod` — application services.
- `apex-data` — stateful infra (PG, Redis) when self-managed; in cloud we typically use managed services and skip this namespace.
- `apex-observability` — Loki, Tempo, Prometheus, Grafana, Alertmanager.
- `apex-security` — Vault, Linkerd control plane (or a separate `linkerd` namespace per Linkerd's convention).
- `apex-system` — operators (cert-manager, external-secrets, etc.).

### 4.2 Node pools

| Pool | Workload | Notes |
| --- | --- | --- |
| `general` | API, orchestrator, AI service, analytics, web | Burstable CPU, 4–8 vCPU per node |
| `workers` | Automation workers | High RAM (16–32 GB), local SSD scratch for browser caches; tainted to repel non-worker pods |
| `data` (self-managed only) | PG primary, Redis | Pinned to AZ; reserved instances |
| `observability` | Loki/Tempo/Prom/Grafana | Cheap, sustained CPU |

Workers have a `dedicated=automation:NoSchedule` taint and a matching toleration; nothing else lands there. The node pool autoscaler scales the `workers` pool by queue depth metric (Phase 4 §8) rather than CPU alone.

### 4.3 Workload spec snapshot

| Workload | Replicas (start) | Resources/replica | Scaling signal |
| --- | --- | --- | --- |
| `web` (nginx) | 2 | 100m / 128 MiB | RPS |
| `api` | 3 | 500m / 1 GiB | RPS p95 latency |
| `orchestrator` | 3 (sharded) | 500m / 1 GiB | Queue lag |
| `ai-service` | 2 | 1000m / 2 GiB | In-flight LLM calls |
| `automation-worker` | 4 | 2000m / 4 GiB; `cpu.cfs_quota = false`, ephemeral storage 8 GiB | BullMQ pending depth |
| `analytics-ingest` | 2 | 500m / 1 GiB | Event lag |
| `outbox-relay` | 2 | 100m / 256 MiB | Outbox lag |
| `migrate-job` | 1 (Job) | 500m / 1 GiB | One-shot per release |

Resource requests are conservative; limits are 2× requests for memory and unset for CPU (CFS throttling kills tail latency). PodDisruptionBudgets ensure at least one of each long-running workload survives during voluntary disruption.

### 4.4 Stateful services

- **PostgreSQL**: managed (RDS / Neon / CloudSQL) in hosted prod. PITR enabled. Cross-AZ standby. We do not run PG in the cluster in hosted prod because operational cost is high and managed offerings provide better DR primitives.
- **Redis**: managed (ElastiCache / Memorystore / Upstash) with cluster mode for queue durability; AOF every-second flush. Two shards minimum for queue + cache split.
- **Object storage**: S3 (or R2). Versioning on the resumes bucket; lifecycle policy on screenshots; encryption with our KMS key (see §10).
- **Vault**: deployed in-cluster as an HA cluster with Raft storage; auto-unseal via cloud KMS. Standalone in self-hosted.

## 5. Configuration management

All app configuration is loaded via `packages/shared-config` from environment variables. Three sources, in precedence order:

1. **Kubernetes Secrets** (mounted as env) — sensitive values, rendered by the External Secrets Operator from Vault.
2. **ConfigMaps** (mounted as env) — non-sensitive runtime config.
3. **Defaults in code** — last resort.

`packages/shared-config` validates the merged result with a Zod schema and crash-fasts on misconfiguration. There is no "default password if env not set" path anywhere.

Feature flags:
- **Ops flags** (e.g., `ANTI_DETECTION_PROFILE`, `AI_TIER_OVERRIDE`) live in ConfigMaps; toggled by deploy.
- **Product flags** (e.g., per-user beta features) live in `users.feature_flags` JSONB and are read at request time.

## 6. CI/CD

### 6.1 Pipelines

`/.github/workflows/ci.yaml` runs on every PR:

```
Stage 1 (parallel):
  - install (pnpm, cached)
  - typecheck (turbo run typecheck)
  - lint (turbo run lint)
  - test:unit (turbo run test:unit)
  - openapi:check (regenerate, fail if drift)

Stage 2:
  - test:integration (testcontainers PG/Redis)
  - test:contract (web ↔ api)

Stage 3 (only on main / release branches):
  - build:images (one job per app, parallel)
  - sign:images (cosign)
  - sbom:upload
```

`/.github/workflows/e2e.yaml` runs nightly + on tag:

```
- spin infra/compose/e2e.compose.yaml
- run apps/web playwright e2e
- run automation-worker offline adapter suite
- run AI eval harness on canonical suites (capped budget)
```

`/.github/workflows/release.yaml` runs on tag `v*`:

```
- verify: image digests exist in registry, signed
- staging deploy: helm upgrade --install -f staging.values.yaml
- run smoke suite against staging (k6 short profile)
- gate: manual approval (CODEOWNERS)
- prod deploy: argocd sync or helm upgrade with the same digests
- run prod smoke suite (read-only)
- announce: post release notes from CHANGELOG.md
```

`/.github/workflows/adapter-canary.yaml` runs nightly:

```
- for each platform adapter: run discovery (read-only) against the real site using a sandbox account
- compare against last-known-good fixtures
- if drift detected: open issue, page on-call
```

### 6.2 Migration discipline

Every release runs `prisma migrate deploy` as a Helm pre-upgrade hook job before the new app pods start. The job is idempotent. If migration fails:
- The release aborts; old pods continue to serve.
- The deployment marks the failed migration; nothing rolls forward until human review.

Migrations are forward-compatible by convention:
- A breaking column change is split into "add column → backfill → cutover code → drop old column," each in its own release.
- The previous version's code must keep running cleanly against the new schema.

### 6.3 Rollback

- App rollback: `helm rollback` to the previous release. Images are immutable; the rollback is instant.
- DB rollback: not by `migrate down` (we don't write down migrations for prod). Forward fixes only. The forward-compatible rule above is what makes this safe.
- Release notes always include the rollback procedure for the specific change.

## 7. Networking

### 7.1 Ingress

- One public ingress (NGINX or AWS ALB) routes:
  - `app.<host>/` → `web` service.
  - `api.<host>/` → `api` service.
  - `api.<host>/socket.io/` → `api` service (sticky for WS).
- TLS terminated at ingress; certs from cert-manager + Let's Encrypt (prod) or a corporate CA (self-host).
- WAF rules in front (Cloudflare/AWS WAF) blocking obvious bots from the marketing path; the authenticated app path is conservative to avoid breaking real users.

### 7.2 Internal mesh

- Linkerd provides mTLS, retry, timeout, and observability primitives. We **do not** put the mesh on the worker egress to platform sites; Linkerd would interfere with TLS to third parties.
- Service-to-service authorization: Linkerd `Server` and `AuthorizationPolicy` resources restrict who can call what (Phase 8 §17).
- Only the `api` service is reachable from outside the cluster; everything else is mesh-internal.

### 7.3 Egress

Strict, namespace-scoped `NetworkPolicy`:

| From | Allowed egress |
| --- | --- |
| `api`, `orchestrator`, `analytics-ingest`, `outbox-relay` | PG, Redis, Vault, AI service, S3 |
| `ai-service` | LLM provider domains (allowlist), PG, Redis, Vault |
| `automation-worker` | Platform domains (allowlist per adapter), Vault, AI service, S3, Redis |
| `web` (nginx static server) | none |

The worker-egress allowlist is explicit per platform: `linkedin.com`, `naukri.com`, etc. New platforms require a network policy update reviewed in PR.

## 8. Autoscaling

- **HPA** for stateless apps (`api`, `ai-service`, `analytics-ingest`, `web`) on CPU and a custom metric (`bullmq_queue_depth` for ingestors; `http_p95_latency` for `api`).
- **KEDA** for queue-driven workers: `automation-worker` scales by `bullmq_pending_jobs{queue="q:platform.apply"}` with a target per replica. KEDA also handles "scale-to-zero" outside business hours for self-hosted single-tenant deployments.
- **Cluster autoscaler** for nodes; the `workers` pool autoscales aggressively (1–N nodes) because per-task cost is proportional to active browsers.
- **AI service caps**: even without HPA, the cost governor (Phase 7) caps spend; HPA only tracks CPU/in-flight calls.

Scale-down protections:
- `automation-worker` has `terminationGracePeriodSeconds: 300` so in-flight applications complete cleanly.
- The orchestrator's heartbeat lease ensures shard ownership transitions don't double-dispatch during a rolling restart.
- HPA stabilization windows are 5 minutes for scale-down (avoid flapping under bursty arrival).

## 9. Observability

### 9.1 Three signals

- **Metrics**: Prometheus scrapes `/metrics` from every service. Grafana dashboards live in `infra/otel/grafana/dashboards/` (versioned).
- **Logs**: Pino → stdout → Loki via Vector or Grafana Agent. Structured JSON; PII redacted.
- **Traces**: OpenTelemetry SDK → Tempo. The web app is also instrumented (RUM) and posts spans through the API to keep the trust boundary clean.

### 9.2 Standard dashboards

Each shipped at chart install:
- **System** — golden signals per service (RPS, latency, errors, saturation).
- **Runs** — active runs, applications/min, success rate, queue depths.
- **AI** — calls/min by tier, cost burn, validation failure rate, governor actions.
- **Adapters** — per-platform success, CAPTCHA frequency, selector drift incidents.
- **Security** — failed logins, MFA enrollments, audit chain integrity, anomaly counters.
- **Costs** — infra cost per user, AI cost per application.

### 9.3 Alerts

- p95 API latency > 400 ms for 10 min — page.
- Apply success rate per platform drops > 25% w/w — page.
- Orchestrator queue lag > 60 s for 5 min — page.
- Audit chain integrity = false — immediate page.
- AI validation failure rate > 1% sustained — ticket.
- Cost burn rate > 2× rolling baseline — ticket.
- Vault unsealed = false — immediate page.

Alert routing: Alertmanager → on-call rotation in PagerDuty/Opsgenie; non-paging alerts to a Slack channel. Every alert has a linked runbook.

### 9.4 Tracing conventions

- Trace IDs are W3C `traceparent`. They flow:
  - Client → API (frontend generates)
  - API → orchestrator/AI/workers
  - Workers → AI service
- Each trace carries `apex.user.id`, `apex.run.id`, `apex.application.id` (all hashed for privacy in metrics; raw in traces because traces are access-controlled).

## 10. Object storage and KMS at deploy time

- Buckets created via Terraform: `apex-resumes`, `apex-screenshots`, `apex-cover-letters`, `apex-backups`, `apex-storage-state`. All have:
  - SSE-KMS with the `apex-data` KMS key.
  - Versioning on `resumes` and `cover-letters`.
  - Lifecycle: screenshots transition to glacier at 90 days, expire at 180 (non-submitted) or 7y (submitted).
  - Bucket policy denying any public access; only IAM roles for app workloads can read/write.
- KMS keys: `apex-data` for object storage, `apex-backups` for DB cold backups. Both have key policies allowing only the relevant service roles.
- Vault unseal key in cloud KMS is a separate key, owned by the platform admin role only.

## 11. Backup and disaster recovery

### 11.1 What we back up

| Asset | Method | Frequency | Retention |
| --- | --- | --- | --- |
| PostgreSQL | WAL streaming + nightly logical dump (encrypted with `kek/backups`) | Continuous + nightly | 30 days online + 1y cold |
| Object storage | Versioned buckets + cross-region replication (prod) | Continuous | Per bucket lifecycle |
| Vault | Snapshot via Vault's API (encrypted) | Daily | 30 days |
| Kubernetes manifests | GitOps: the cluster *is* the manifests | n/a | Forever (git) |
| Secrets | Stored in Vault; ESO syncs to k8s | Vault snapshot covers it | See above |
| Loki/Tempo | Object-storage-backed; lifecycle 30 days hot, 90 days cold | Continuous | 90 days |

### 11.2 Targets

- **RPO** (acceptable data loss): 60 seconds for PG, 0 for object storage, 24 hours for Loki.
- **RTO** (acceptable downtime): 30 minutes for PG, 30 minutes for the rest.
- **Drills**: quarterly, executed against a parallel staging cluster restored from prod cold backup; sign-off ticket required. Drills cover at minimum: PG PITR to T-15 minutes, Vault unseal from cold key, full app re-roll from images.

### 11.3 What is not backed up

- Browser context storage states beyond their TTL: deliberately. Compromised contexts should die with the system.
- BullMQ queues mid-run: BullMQ + AOF Redis + idempotency keys mean a Redis loss replays at most a few in-flight tasks (idempotent).

## 12. Multi-region story

The hosted product launches single-region (M9). The schema and ID strategies (ULID, `user_id` everywhere) are friendly to a future multi-region split:

- Read replicas in additional regions for analytics dashboards.
- Worker pods can run regionally close to the user (fewer cross-Pacific latency penalties on platform sites).
- Multi-master is **not** on the roadmap; conflict resolution would touch every state machine.

## 13. Self-hosted profile

A first-class deployment shape, not an afterthought.

### 13.1 Two flavors

1. **Single-node** (`infra/compose/selfhost.compose.yaml`): one VM, Docker Compose, all services + PG + Redis + MinIO + Vault dev profile. Suitable for individual users.
2. **Single-tenant cluster** (Helm chart with `selfhost.values.yaml`): a small k8s (k3s, microk8s, or full) for a power user or a small team.

### 13.2 What changes vs hosted prod

- LLM provider keys are user-supplied via the Vault dev profile.
- KMS is age-encrypted local Vault; the operator manages backups (we provide the script).
- Object storage is MinIO; backups go to a folder the operator chooses.
- Observability ships an embedded Grafana with the same dashboards, exposed at a private port.
- No cross-region anything; no managed PG.
- Updates are pulled (signed images) rather than pushed; an updater container checks releases and prompts the operator.

### 13.3 What stays identical

- The same migrations, the same prompts, the same adapters, the same UI.
- The same audit chain, the same crypto envelope (with a different KEK source).
- The same Helm chart, with `mode: selfhost` toggling resource sizes and defaults.

## 14. Local development

`pnpm dev` brings up the entire stack:

- `infra/compose/dev.compose.yaml` starts PG (with extensions), Redis, MinIO, MailHog, Vault dev, and an OTel collector that prints traces to stdout.
- `turbo dev` runs `apps/web` (Vite), `apps/api`, `apps/orchestrator`, `apps/ai-service`, `apps/automation-worker`, `apps/analytics` in watch mode.
- Seeds populate `platforms`, `permissions`, `roles`, `ai_models`, `ai_prompts` (active versions), and an optional demo user.
- Prompts default to the `MOCK` provider unless `ANTHROPIC_API_KEY` is set; this lets engineers iterate without burning budget.

Onboarding target: `git clone && pnpm i && pnpm dev` produces a working stack in under 5 minutes on a modern laptop.

## 15. Release management

- `main` is always deployable. PRs are merged via squash + Conventional Commits.
- Versioning of internal packages via `changesets`; apps are versioned by release tag, not per-package.
- Cadence: weekly release on Tuesdays in a stable phase; daily on demand during M0–M3.
- Each release has a CHANGELOG entry (auto-generated from changesets) and a release note posted to the Activity tab so users see what changed.

## 16. Cost model and budgets

This is a load-bearing concern, not a footnote. Three cost centers:

1. **Compute** — workers dominate. Each active context costs ~1 GiB RAM and bursty CPU. We size by 95th-percentile concurrent active contexts in the past 7 days, not by peak.
2. **AI** — second largest. Capped per user (Phase 7); aggregated cost reported per environment.
3. **Storage and egress** — modest. Screenshots are the largest line item; lifecycle to glacier is what keeps it sane.

Monthly budget alerts wired to Slack, derived from cloud billing exports + AI provider invoices ingested as Prometheus metrics.

## 17. Compliance posture

- **SOC 2** (Type 1 in M9, Type 2 in M9+6mo): we ship the controls (audit chain, MFA, change management, vendor management) from M0; SOC 2 evidence is the byproduct.
- **GDPR / DPDP** (India): right to access (`POST /me/export`), right to erasure (Phase 8 §19), DPA template ready for self-host customers.
- **ISO 27001** considered for M9+1y if customers ask for it.

We do not collect more data than necessary; minimal data is the cheapest compliance posture.

## 18. Performance budgets at deploy time

Carried over from earlier phases, pinned for SLO tracking:

- API p95 read < 120 ms, command < 250 ms.
- Orchestrator dispatch tick < 50 ms.
- AI score (batch=8) < 1 s p95.
- AI answer < 1.5 s p95.
- End-to-end one application < 75 s p95 (bounded by the platform).
- Web LCP < 1.8 s on 4G mid-tier; INP < 100 ms p95.

A budget breach by 10% for two consecutive weeks triggers a perf review.

## 19. Tradeoffs accepted

- **Single-region launch.** Simpler ops; we accept latency for users far from the region. Multi-region is a future investment.
- **Managed PG over self-managed.** Less knob control; far better DR primitives. Worth it.
- **Linkerd over Istio.** Smaller blast radius in Linkerd's failure modes; some advanced routing missing. We rarely need it.
- **Helm + ArgoCD over a custom operator.** Boring, predictable; loses some declarative ergonomics. Boring is good in deploy.
- **Self-host as a first-class shape.** Adds testing surface (Compose + Helm both maintained); pays back in customer trust and a clear path for users who insist on data sovereignty.
- **Forward-only migrations.** Discipline tax up front; real safety on rollback.

## 20. What this phase deliberately does not decide

- The specific cloud provider (AWS vs GCP vs hybrid) — Terraform modules abstract it; the chart runs anywhere.
- The exact node sizes — set during the M0 capacity plan with concrete pricing.
- The CDN choice for the web app — chosen at M9 launch.
- The SOC 2 auditor — chosen during M9.
- The on-call rotation tooling — chosen during M9 (PagerDuty default).
