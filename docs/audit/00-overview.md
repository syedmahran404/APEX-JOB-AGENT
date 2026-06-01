# APEX JOB AGENT — Architecture Audit & Refinements

This folder is the output of a comprehensive audit of the architecture in [`docs/architecture/`](../architecture). It is **not** a rewrite. It records:

1. Concrete weaknesses found on re-read.
2. Missing enterprise-grade features.
3. The refined implementation plan that incorporates the corrections.
4. The final file structure that adds the missing services.
5. The database additions and index revisions.
6. A disciplined tech-stack review.
7. A production-readiness model at 10 / 100 / 1000 applications per day per user.

Where an audit finding contradicts the original architecture, **the audit wins**, and the original document will be amended in a follow-up housekeeping PR before M0 begins.

---

## Top 10 corrections (read this if you read nothing else)

| # | Where | Finding | Fix (one line) |
| --- | --- | --- | --- |
| 1 | Phase 3 §4.6 | `UNIQUE(user_id, job_id)` on `applications` blocks legitimate retries after a transient failure. | Replace with a partial unique index `WHERE status NOT IN ('failed_*','skipped_*')`. |
| 2 | Phase 3 §4.2 | `embeddings.vector` is hard-coded at `vector(1024)`; switching providers breaks the column. | Split into per-dim sibling tables (`embeddings_1024`, `embeddings_3072`) behind a view; or per-model partitions. |
| 3 | Phase 3 missing | `outbox_events` defined in Phase 4 §6 not present in schema. | Add to canonical schema. |
| 4 | Phase 3 missing | Idempotency-key store (Redis 24h + PG backstop) referenced in Phase 4 §3.5 not in schema. | Add `idempotency_keys` table. |
| 5 | Phase 7 §7 | Cost governor lacks an atomic decrement protocol — concurrent calls can both pass at 99% budget. | Use `UPDATE ai_cost_ledger SET ... WHERE day=? AND cost_usd + ?<= ceiling RETURNING ...` inside a CTE. |
| 6 | Phase 9 §4 | Socket.IO multi-replica without `socket.io-redis-adapter` will silently drop cross-instance events. | Mandate Redis adapter; add to Helm chart M0. |
| 7 | Phase 1 missing | No scheduler service. Recurring runs, periodic maintenance, calibration, canary, partition rollover, token-bucket reset, embedding refresh are all unowned. | Introduce `apps/scheduler` (PostgreSQL-backed cron with leader election) as a 10th service. |
| 8 | Phase 6 missing | Cross-platform job dedupe — same employer posting on LinkedIn + Naukri + Indeed is treated as three different jobs. | Add `job_canonical_keys` (employer + title + location hash) → `job_id` mapping; orchestrator filters by canonical. |
| 9 | Phase 8 missing | Per-user device fingerprint never rotates, even after high CAPTCHA frequency (likely compromise heuristic). | Add a fingerprint-rotation policy keyed on `security_events` density per `(user, platform)`. |
| 10 | Phase 7 §8 | `captcha.classify` and `qa.normalize` AI costs not deducted from user daily budget. | All AI calls (including classifiers) flow through the gateway; the governor decrements every call uniformly. |

---

## Top 8 missing features (Step 2 highlights)

1. **Scheduler service** — recurring runs (e.g., "every weekday at 9am, multi-platform run"), saved-search alerts, periodic maintenance with leader election.
2. **Webhook system** — user-defined outbound webhooks for application events (CRM / Notion / Sheets integrations) with HMAC signing, retry, and DLQ.
3. **Email ingestion** — inbound email mailbox per user (recruiter replies) parsed into `application_events` to update status without manual entry.
4. **Bulk operations infrastructure** — durable, resumable bulk approve/reject/withdraw with progress, undo window, and idempotency.
5. **Dry-run mode** — preview what a run *would* do (jobs found, scores, decisions, AI cost forecast) without submitting; first-class flag on `job_runs.mode_suffix`.
6. **Job dedupe across platforms** — canonical key + first-applied-wins so we don't apply to the same job on three sites.
7. **Customer-support consented impersonation** — time-boxed support sessions logged in `support_sessions` with explicit user grant + revocable + auditable.
8. **Adapter / platform health board** — first-class user-facing surface in `Settings → Platforms` showing per-platform: canary status, drift incidents in last 7 days, CAPTCHA frequency, autonomous-skip rate.

(Full list: [`02-missing-features.md`](./02-missing-features.md).)

---

## Top 5 production-readiness facts

| Statement | Reality |
| --- | --- |
| 10 apps/day/user × 1000 users = 10k apps/day | Comfortable. ~5 worker pods, ~$50/day AI at default budget. |
| 100 apps/day/user × 1000 users = 100k apps/day | Achievable but expensive. ~70 worker pods sustained, $500–$2,500/day AI total, demands per-platform pacing tuned and AI tier routing aggressive. |
| 1000 apps/day/user is **not platform-feasible** | One identity making 1000 actions/day on LinkedIn or Naukri trips anti-abuse heuristics regardless of our cleverness. We treat this as an explicit cap, not an aspiration. |
| Largest cost driver | AI, by an order of magnitude over compute. The cost governor and tier routing are the load-bearing controls. |
| Largest reliability driver | Selector drift on platform redesigns. The canary system + layered selectors + adapter version pinning + hotfix loop is the load-bearing control. |

(Full model: [`07-production-readiness.md`](./07-production-readiness.md).)

---

## Document index

| File | Step | Read time |
| --- | --- | --- |
| [`01-architecture-validation.md`](./01-architecture-validation.md) | Step 1: per-component validation, every weakness with issue / impact / fix / why-superior | 20 min |
| [`02-missing-features.md`](./02-missing-features.md) | Step 2: missing enterprise features grouped by domain | 15 min |
| [`03-implementation-plan.md`](./03-implementation-plan.md) | Step 3: phases revised to absorb the audit corrections | 10 min |
| [`04-final-file-structure.md`](./04-final-file-structure.md) | Step 4: production-ready layout with new services | 5 min |
| [`05-database-additions.md`](./05-database-additions.md) | Step 5: new tables, revised indexes, partitioning corrections | 15 min |
| [`06-tech-stack-review.md`](./06-tech-stack-review.md) | Step 6: every major tech with rationale, alternatives, pros, cons, scalability impact | 15 min |
| [`07-production-readiness.md`](./07-production-readiness.md) | Step 7: 10 / 100 / 1000 apps/day capacity model | 10 min |

---

## Outcome of the audit

The architecture is sound at the macro level. The **shape** does not change: modular monolith, PG + Redis + S3 + Vault, NestJS + React, Playwright workers, Anthropic + OpenAI providers behind an LLM gateway, audit-everything by default. What changes:

- **One new service** (`apps/scheduler`).
- **15 new tables** (schedules, saved searches, webhooks, idempotency, outbox, dedupe, bulk operations, ingestion, support sessions, feature flags, experiments, etc.) — all small, all with clear ownership.
- **~30 corrections and tightening notes** across the original phase docs.
- **A revised cost model** that is honest about per-user AI ceilings.
- **A pacing posture** that is honest about platform-side hard caps.

After this audit lands, **a senior engineering team can begin M0 (Foundations) immediately** without needing further architectural discussion. M0 picks up the original Phase 10 §3 scope plus the schema and tech additions called out here.
