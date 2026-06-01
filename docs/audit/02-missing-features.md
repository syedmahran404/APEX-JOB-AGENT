# Audit Step 2 — Missing Features Analysis

The architecture covers the obvious enterprise pillars (monitoring, logging, audit, queues, backup, permissions, resume versioning, AI decision tracking). This step lists features that a production-grade daily-use system needs **but the architecture did not specify**. Each item carries:

- **What** — the feature.
- **Why** — the user/operational reason it is needed.
- **Where it belongs** — the service or package that owns it.
- **Effort** — relative complexity.
- **Milestone** — when it lands per the revised plan.

Severity follows the same scale as Step 1: **S1** missing = the system is unsafe or unusable without it; **S2** missing = the system loses meaningful capability or pays meaningful cost; **S3** missing = quality-of-life or future-proofing.

---

## 1. Scheduler service (S1)

**What.** A dedicated service (`apps/scheduler`) with leader election that owns:
- **User-facing recurring runs** — "Every weekday at 9am IST, run multi-platform with target=20."
- **Saved-search alerts** — periodic re-discovery against a pinned query, push to user when fresh matches appear.
- **System maintenance crons** — partition rollover (`pg_partman` worker), `analytics_rollups` refresh, calibration job, adapter canary, drift detection sweep, embedding refresh queue drain, idempotency-key reaper, audit-chain verifier, DR-drill ticket opener.

**Why.** The original architecture has **no service** that owns time-based work. Maintenance jobs are scattered as gestures across phases ("a daily reaper", "a weekly recalibration", "nightly canary"). Without a single owner, they will be forgotten, duplicated, or implemented as kubernetes `CronJob` manifests that have no telemetry, no leader election, no overlap protection, and no resume.

User-facing scheduling is a first-class feature: a user wants to wake up to the day's applications already submitted. Without it, the product is reactive only.

**Where it belongs.** New `apps/scheduler` (NestJS), reusing `packages/queue`, `packages/db`, `packages/realtime`. Leader election via `pg_advisory_lock` on a well-known key.

**Effort.** Medium. Two weeks to ship the maintenance side; one more week for user-facing recurring runs and saved searches.

**Milestone.** Phase 4 (M2 in the revised plan); the maintenance crons it owns are needed by M2 anyway.

**Schema additions** (full SQL in [`05-database-additions.md`](./05-database-additions.md)):
- `schedules` — user-defined cron expressions for runs.
- `schedule_runs` — history of triggered runs.
- `saved_searches` — pinned discovery queries.
- `saved_search_matches` — discovered matches to alert on.
- `system_jobs` — registry of system crons with last-run + locking.

---

## 2. Webhook system (S2)

**What.** User-defined outbound webhooks for application/run events. The user registers `https://my-crm.example/apex-webhook` with a secret; we POST signed JSON envelopes for events they subscribe to (`application.submitted`, `application.shortlisted`, `application.offer`, `run.finished`, etc.). Failures are retried with exponential backoff; non-2xx after N retries lands in DLQ.

**Why.** Power users keep their own pipelines (Notion DB, Google Sheet, custom CRM, Slack). Without webhooks, they manually re-key data — defeating the agent's purpose.

**Where it belongs.** Inside `apps/api` for management endpoints; delivery worker as part of `apps/scheduler` (it's queue-driven, time-aware).

**Effort.** Small. ~1 week.

**Milestone.** Phase 5 (M5–M7 area).

**Schema additions:**
- `webhooks` — registered endpoints + HMAC secret + subscribed events.
- `webhook_deliveries` — audit log of delivery attempts (status, latency, bytes, retry count).

---

## 3. Email ingestion (S2)

**What.** Each user gets a unique inbox alias (e.g., `u-{user_id}@inbox.apex.example`). Recruiter replies addressed to that alias are parsed and matched (by employer, role, message-id correlation, and AI classification) to the corresponding `applications` row, updating `applications.status` to `viewed`/`shortlisted`/`interview_scheduled`/`rejected` automatically.

**Why.** Application status is the primary success signal but it is buried in the user's email. Without ingestion, the analytics dashboard's response/conversion rates are unreliable; users must manually update statuses, which they don't.

**Where it belongs.** New `apps/email-ingest` (or a module in `apps/automation-worker` since it shares idempotency patterns). Inbound provider: AWS SES + S3 + SNS, or Postmark inbound, depending on deployment.

**Effort.** Medium. ~2 weeks. The classifier prompt is small but auditable.

**Milestone.** Phase 6 (M6 area in revised plan).

**Schema additions:**
- `inbox_aliases` — alias → user_id mapping; rotation supported.
- `email_messages` — raw + parsed metadata (encrypted body).
- `email_application_matches` — match candidates with confidence; user can override.

**Privacy note.** Inbound mail is treated as Tier-1 sensitive: encrypted with the user DEK at rest, redacted in logs, never sent to third-party AI without explicit per-user consent (off by default; classifier runs on a self-hosted small model OR on the existing AI gateway only when the user opts in).

---

## 4. Bulk operations infrastructure (S2)

**What.** First-class durable bulk operations: bulk withdraw applications, bulk approve suggestions, bulk skip jobs, bulk re-tier scoring threshold. Each bulk op:
- Has a dedicated `bulk_operations` row (idempotent).
- Streams progress as events to the UI.
- Supports pause/resume.
- Has an undo window (e.g., 5 minutes for "withdraw 50 applications").

**Why.** Power users routinely need bulk actions; the absence forces them into REST loops, which break under partial failure.

**Where it belongs.** `apps/api` exposes commands; orchestration is by `apps/scheduler` (sub-tasks dispatched into BullMQ).

**Effort.** Small-Medium. ~1 week.

**Milestone.** Phase 5.

**Schema additions:**
- `bulk_operations` — id, kind, params, status, total, succeeded, failed, undo_until, created_by.
- `bulk_operation_items` — per-item progress (resumable).

---

## 5. Dry-run mode (S2)

**What.** A run flag `dry_run: true` that performs everything **except** the final submit. Discovery, scoring, question answering, resume choice, decision logging — all happen and are visible in the UI as a "What would have happened" report. AI cost is metered as in a real run.

**Why.** The first time a user enables a new platform, or when they tune the threshold, or when they want to preview what a recurring schedule will produce, dry-run is the safe path. Without it, the user "tests" with real applications.

**Where it belongs.** Orchestrator + adapter changes. Adapters take a `submitMode: 'live'|'dry'` flag and short-circuit the final submit step.

**Effort.** Small. ~3 days, mostly UI surfacing.

**Milestone.** Phase 4 (alongside scheduler / first multi-platform).

**Schema additions:**
- `job_runs.dry_run BOOLEAN NOT NULL DEFAULT false`.
- `applications.was_dry_run BOOLEAN NOT NULL DEFAULT false` (we still record the row so the user can see what would have been submitted).

---

## 6. Job dedupe across platforms (S2)

(Cross-listed from Step 1 §C1; included here because it is a missing feature with user-visible consequences.)

**What.** Canonical job key + first-applied-wins. The same posting on LinkedIn + Naukri + Indeed yields **one** application; the others are tagged `duplicate` and visible to the user.

**Why.** Avoids spamming employers, halves AI cost on cross-listed jobs, matches user mental model.

**Where it belongs.** Discovery + orchestrator.

**Effort.** Small. Schema + orchestrator filter + minor UI.

**Milestone.** Phase 4.

**Schema additions:**
- `job_canonical_keys` (defined in Step 1 §C1).
- `jobs.canonical_key TEXT NOT NULL` (with FK).

---

## 7. Customer-support consented impersonation (S2)

**What.** A support role can request a time-boxed (default 60 min) view of a user's account. The user receives a notification with the support agent's identity and the reason; on consent, a `support_sessions` row is created with explicit start/end timestamps and an audit trail of every action the support agent takes. The agent never sees plaintext credentials, ever.

**Why.** Supporting users without this leads to bad shortcuts (sharing screenshots, copying emails). Operationalizing this from M0 makes support both effective and auditable.

**Where it belongs.** `apps/api` for the consent flow + scoping; `audit_log` carries `actor_kind = 'support'` rows.

**Effort.** Small-Medium. ~1 week.

**Milestone.** Phase 6.

**Schema additions:**
- `support_sessions` — id, user_id, agent_id, reason, scope_json, granted_at, expires_at, revoked_at.
- `support_actions` — audit of every action taken (read or attempted write) within a session.

---

## 8. Adapter / platform health board (S3)

**What.** A user-facing surface in `Settings → Platforms` showing per-platform: canary status (last 7 nights), drift incidents in last 7 days, CAPTCHA frequency, autonomous-skip rate, and the **adapter version pinned for the user's most recent run**.

**Why.** Trust is observable. When a platform is shaky, the user should see why their numbers dropped without our support team telling them.

**Where it belongs.** `apps/web` (read-only view); data sourced from `apps/analytics` rollups.

**Effort.** Small. ~3 days.

**Milestone.** Phase 7.

---

## 9. Notification system breadth (S2)

**What.** Beyond the in-app and email channels mentioned in Phase 4, add:
- **Push notifications** (PWA: web-push protocol; later mobile if it ships).
- **Webhook channel** (separate from §2 above; per-event subscribe).
- **Quiet hours enforcement** (delay non-critical notifications outside `quiet_hours_start..end` per user).
- **Per-event subscription matrix** (user picks per-event-type which channels fire).

**Why.** Phase 4 §2.6 listed channels but did not design the matrix. Without quiet hours, users disable notifications altogether.

**Where it belongs.** `apps/api` (settings) + `apps/scheduler` (delivery + quiet-hours queueing).

**Effort.** Small-Medium. ~1.5 weeks.

**Milestone.** Phase 6.

**Schema additions:**
- `notification_preferences` — per user, per event kind, per channel.
- `notifications.deferred_until TIMESTAMPTZ` for quiet-hours queueing.

---

## 10. Feature-flag system (proper) (S2)

**What.** A first-class feature-flag system distinct from environment-driven ops flags. Flags can be:
- **Boolean** (on/off).
- **Variant** (A/B, with deterministic user-bucketing via hash).
- **Targeted** (by tenant, plan, locale).

A `feature_flags` table holds definitions; `experiment_assignments` tracks per-user variant assignment for stable bucketing.

**Why.** Phase 9 §5 mentioned product flags as "JSONB on users" — too primitive. A real flag system is needed for safe rollouts of new prompts, new adapters, new UI.

**Where it belongs.** `packages/feature-flags` (small library) + DB tables + admin UI in `apps/web` (admin-only).

**Effort.** Small. ~1 week.

**Milestone.** Phase 4.

**Schema additions:**
- `feature_flags`, `feature_flag_rules`, `experiment_assignments`, `experiment_outcomes`.

---

## 11. Status page + incident communication (S3)

**What.** Public status page (e.g., `status.apex.example`) that surfaces:
- Per-component health (API, AI, automation per platform).
- Active incidents with timeline updates.
- Historical uptime per service.

Powered by the same Prometheus + Grafana stack with a public-facing reverse proxy that exposes only allowlisted dashboards.

**Why.** Phase 9 mentions "status page integration" but doesn't design it. Users want a single place to check before filing tickets.

**Where it belongs.** Static SPA driven by the analytics service's public health endpoints. Distinct from the user-facing health board (§8) which is per-user and authenticated.

**Effort.** Small. ~3 days for MVP.

**Milestone.** Phase 7 (with public beta).

---

## 12. Email & transactional system (S2)

**What.** A proper transactional-email layer:
- Provider abstraction (SES + Postmark + SMTP) behind one client.
- Templates versioned in the repo with i18n support.
- Bounce / complaint handling that flows back to `users.email_status`.
- Per-user `delivery_caps` to avoid spam-filter triggers.
- Inbound bounce processing (suppression list).

**Why.** Phase 4 §2 mentioned MailHog for dev but never designed the prod stack. Real email delivery is its own discipline.

**Where it belongs.** `packages/email` + `apps/scheduler` (for retries and digest assembly).

**Effort.** Medium. ~2 weeks.

**Milestone.** Phase 4.

**Schema additions:**
- `email_templates` — versioned, locale-aware.
- `email_deliveries` — audit per send.
- `email_suppressions` — bounce list.
- `users.email_status` — `verified | bouncing | complained | suppressed`.

---

## 13. Onboarding telemetry (S3)

**What.** Discrete tracked steps in onboarding (resume parsed, profile facts confirmed, preferences set, first platform connected, first run started, first application submitted) with timestamps. Drop-off funnel visible to operators.

**Why.** Onboarding is the single most important UX surface. Without telemetry, we cannot improve it.

**Where it belongs.** `apps/web` emits events; `apps/analytics` aggregates.

**Effort.** Small. ~3 days.

**Milestone.** Phase 5 (alongside onboarding wizard polishing).

**Schema additions:**
- `onboarding_milestones` — user_id, milestone, achieved_at.

---

## 14. AI prompt safety classifier (S2)

**What.** A small content-safety classifier that runs over every AI **output** before persistence and use:
- PII leakage detection (did the model echo a different user's data?).
- Toxicity / harassment detection.
- Prompt-injection echo detection (did the output contain instructions from the untrusted block?).

Outputs failing the safety check are quarantined; the user is shown a redacted notice.

**Why.** Phase 7's safety rules are good but the verification is implicit. A classifier closes the loop.

**Where it belongs.** `apps/ai-service` post-processing; uses the `fast` tier model.

**Effort.** Small. ~1 week.

**Milestone.** Phase 5.

**Schema additions:**
- `ai_decisions.safety_score NUMERIC(4,3) NULL`
- `ai_decisions.safety_action TEXT NULL CHECK (safety_action IN ('passed','redacted','blocked'))`

---

## 15. Outbound proxy auditing (S3)

**What.** Phase 8 mentions an envoy proxy for worker egress with logging. The audit needs:
- Per-request structured log: timestamp, src service, dest host, bytes up/down, status.
- Anomaly detection: a worker requesting an unfamiliar host triggers a `security_events` row.
- Allowlist drift detection: any new host the worker reaches that isn't in the policy fails closed.

**Why.** A compromised worker (supply-chain or browser exploit) tries to phone home. The proxy is the chokepoint where we notice.

**Where it belongs.** `infra/otel/` configuration; `apps/analytics` consumes proxy logs.

**Effort.** Small. ~3 days for the pipeline; the policy itself ships in M0.

**Milestone.** Phase 4.

---

## 16. Per-tenant cost attribution (S2)

**What.** When M9 multi-tenant lands, billing must be fair. Today's `ai_cost_ledger` is per-user; tenants need rollups including:
- Per-tenant per-platform application counts.
- Per-tenant AI cost (sum across users).
- Per-tenant compute attribution (worker minutes used).

**Why.** Phase 9 §16 mentions cost alerts but no per-tenant attribution. A tenant cannot be billed without it.

**Where it belongs.** `apps/analytics`; new tables surfaced via API.

**Effort.** Medium. ~2 weeks.

**Milestone.** Phase 8 (M9-equivalent).

**Schema additions:**
- `tenant_cost_rollups` — per tenant, per day, per cost class.
- `worker_compute_attributions` — per `(user, platform, run, task)` runtime ms.

---

## 17. Application "second pass" / refresher (S3)

**What.** A scheduler-driven sweep of submitted applications:
- Re-fetch the job page (still live? closed? company changed?).
- For applications older than 14 days without a status update, suggest follow-up actions.
- Detect "ghosted" applications (no events in 30 days) and downgrade to `closed_no_response` for analytics fidelity.

**Why.** Application outcomes are an asymmetric signal stream. Without a refresher, the funnel data drifts toward "applied" and never closes.

**Where it belongs.** `apps/scheduler` orchestrating; `apps/automation-worker` doing per-job re-fetches.

**Effort.** Small. ~3 days.

**Milestone.** Phase 7.

**Schema additions:**
- `applications.last_refreshed_at TIMESTAMPTZ NULL`
- New status: `closed_no_response`.

---

## 18. Security telemetry response loop (S2)

**What.** `security_events` already collects signals; the missing piece is a **rules engine** that drives actions:
- `failed_login` × 5 in 30 minutes → lock the user.
- `captcha.encountered` × 3 in 1 hour for one platform → pause auto-runs for that platform; notify.
- `permission.grant` from a new device → require a fresh WebAuthn proof on the next sensitive action.
- `credential.read` outside business hours **without** an active run → page on-call.

**Why.** Collecting events without acting on them is theatre.

**Where it belongs.** `apps/scheduler` (rules engine, not real-time hot-path) reading from `security_events`; actions taken via internal API to `apps/api`.

**Effort.** Small-Medium. ~1.5 weeks.

**Milestone.** Phase 6.

**Schema additions:**
- `security_rules` — id, kind, threshold, window, action, enabled.
- `security_rule_triggers` — audit of every rule firing.

---

## 19. Multi-locale support beyond Hindi (S3)

**What.** Phase 5 mentions Hindi at M9. The architecture should make adding locales mechanical: `i18next` resources per locale; date/number/currency via `Intl`; RTL-readiness with logical properties; locale-aware analytics formatting; locale-aware AI prompts (some prompts must respect the user's locale, especially `cover.letter`).

**Why.** Adding the second locale exposes shortcuts in the codebase. Designing for "any locale" from M0 makes future locales a config addition.

**Where it belongs.** `apps/web/src/i18n` + `packages/ai-core/style/locales/`.

**Effort.** Small. ~3 days for the framework; ongoing per-locale.

**Milestone.** Phase 1 (M0) for the framework; specific locales as demand surfaces.

---

## 20. Data export schedule + retention transparency (S3)

**What.** In addition to the on-demand `POST /me/export`, support:
- **Scheduled exports** — weekly ZIP delivered to the user's email.
- **Retention transparency** — a Settings page showing exactly what we hold, where, for how long.

**Why.** Trust is observable. Users who run the agent daily build up a lot of data; they should be able to verify what we have and when it expires.

**Where it belongs.** `apps/api` for the policy; `apps/scheduler` for scheduled exports.

**Effort.** Small. ~3 days.

**Milestone.** Phase 7.

**Schema additions:**
- `data_export_schedules` — frequency, last_run, channel.
- `data_export_jobs` — per-export status.

---

## Summary of additions

| Theme | New services | New tables (count) | Aggregate effort |
| --- | --- | --- | --- |
| Time-based work (Sched., webhooks, email, bulk) | `apps/scheduler`, `apps/email-ingest` (or worker module) | ~12 | ~7 weeks |
| User-visible features (dry-run, dedupe, health board, status page) | none new | ~3 | ~2 weeks |
| Trust & support (consented impersonation, security rules, prompt safety) | none new | ~6 | ~3 weeks |
| Operations (feature flags, locale framework, cost attribution) | none new | ~4 | ~3 weeks |
| Lifecycle (refresh, exports, retention transparency) | none new | ~3 | ~1 week |

**Total new tables: ~28** added to the ~46 existing → final schema ~74 tables.
**One new service** (`apps/scheduler`); email ingestion is a module decision (worker vs separate app, deferred to M6).
**Aggregate engineering effort to ship all 20 missing features: ~16 engineer-weeks**, distributed across the revised milestones in [`03-implementation-plan.md`](./03-implementation-plan.md).

None of these are nice-to-haves. Each closes a real gap: a missing user feature, a missing operator feature, a missing trust feature, or a missing lifecycle feature.
