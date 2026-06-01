# Audit Step 3 — Revised Implementation Plan

This is the post-audit plan. It supersedes [`docs/architecture/10-implementation-roadmap.md`](../architecture/10-implementation-roadmap.md). The original 11 milestones (M0..M10) are consolidated into **7 phases** that group work by *capability shipped*, with the audit's S1 blockers placed in the earliest phase that can absorb them and the S2 material findings placed in their natural owners.

Each phase carries:

- **Objective** — the single sentence that defines "done."
- **Deliverables** — what ships.
- **Dependencies** — what must exist before this phase begins.
- **Risks** — what can derail it and how it's contained.
- **Complexity** — relative size (Small / Medium / Large) plus rough engineer-weeks.

Pacing assumes a focused team of 4 engineers + 1 designer + 0.5 SRE. Total path to production beta: **~32 engineer-weeks of critical path** (compressing M0..M10's ~37 weeks because some work parallelizes).

---

## Phase 1 — Foundations & corrections (formerly M0–M1)

### Objective

A user can sign up with WebAuthn, complete onboarding, seal credentials in the vault, and have the entire architectural skeleton observable, secure, and ready to host the run lifecycle. **All four S1 audit blockers are fixed in this phase.**

### Deliverables

**Infrastructure:**
- Monorepo workspaces wired (`pnpm` + `Turborepo`); the 7 custom ESLint boundary rules implemented and gating CI.
- `tsconfig.base.json` strict; package-level `tsconfig.json`s extending it.
- Root tooling files (`package.json`, `pnpm-workspace.yaml`, `turbo.json`, `.editorconfig`, `.prettierrc.cjs`, `.nvmrc`, `.env.example`, `CODEOWNERS`).
- Local dev compose stack (`infra/compose/dev.compose.yaml`) with PG (extensions), Redis, MinIO, Vault dev profile, MailHog, OTel collector. `pnpm dev` brings up green stack in < 5 minutes on a clean machine.
- CI: `ci.yaml` runs install/typecheck/lint/test/build/openapi-check/gitleaks/osv-scanner.
- Helm chart skeleton with all Phase-9 service stubs.

**Security primitives:**
- `packages/crypto` with envelope encryption (AES-256-GCM + AAD) and HKDF subkey derivation. Round-trip tests against dev Vault. **Two-reviewer rule active.**
- `packages/vault-client` with KEK wrap/unwrap, lease+redeem, PKI client. **Two-reviewer rule active.**
- `packages/shared-config`, `packages/shared-logger` (PII redaction defaults), `packages/shared-errors`, `packages/shared-events`.
- Vault policy: production-mode self-host profile (audit fix F1) — **not** Vault dev mode in self-host.

**Database (subset):**
- Prisma schema with M0 tables: `users`, `user_sessions`, `webauthn_credentials`, `totp_secrets`, `mfa_recovery_codes`, `roles`, `user_roles`, `permissions`, `user_permissions`, `platforms` (static), `audit_log`.
- Hash-chain trigger on `audit_log` (with the per-tenant chain head from audit fix A8 — `tenant_id` defaults to a singleton until M9 multi-tenant lands; the chain shape is multi-tenant from day one).
- `idempotency_keys` table (audit fix A4) backstop; Redis 24h hot path.
- `outbox_events` table (audit fix A3) — needed by Phase 2 but defined now.

**Identity & onboarding:**
- WebAuthn-first auth + email/password fallback + TOTP secondary; recovery codes; sessions (`__Host-` cookie + DB hash + revocation Pub/Sub).
- Step-up MFA guard for sensitive paths.
- RBAC + permission scope guards.
- Credential vault flow (UI modal + API seal).
- Onboarding wizard (5 steps); resume parser (basic in this phase; ML enhancement in Phase 3).
- `audit_log` populated for every consequential action.
- Activity timeline UI (read-only).
- `POST /me/export` and `DELETE /me` (with grace + DEK destruction).

**Audit blockers fixed:**
- **A1** (applications uniqueness) — schema-only correction; no code yet to apply, but Prisma schema baseline is correct.
- **B1** (cost governor atomic decrement) — `ai_cost_ledger` schema includes the atomic-update SQL pattern in the repository helper.
- **B3** (Socket.IO Redis adapter) — wired into `packages/realtime` from day one.
- **F1** (self-host Vault profile) — production-mode Vault config in `infra/compose/selfhost.compose.yaml`.

**Other audit fixes folded in:**
- A8 (per-tenant audit chain shape).
- F2 (sticky-by-session-id consistent hashing in ingress) — config baked in.
- F4 (CSP nonce-based inline styles).
- F5 (trusted-device 30-min step-up window).
- G3 (separate `/healthz` vs `/readyz`).
- H4 (`tools/db-scrub/rules.yaml` enforced in CI).

### Dependencies

None (this is the foundation).

### Risks

- WebAuthn library churn — mitigated by `@simplewebauthn` choice (mature, used widely).
- Vault HA setup is operationally heavy — we ship single-node dev/self-host first; HA is deferred to Phase 7.
- ESLint custom rules are non-trivial; allocate one full engineer-week to write and battle-test the seven rules.

### Complexity

**Large** — 5 engineer-weeks (4 eng × ~5 wks of foundation work, plus 1 wk for security primitives and audit fixes).

### Exit criteria (machine-checkable)

- `git clone && pnpm i && pnpm dev` < 5 min, green stack.
- A new user signs up, enrolls WebAuthn, finishes onboarding, connects LinkedIn (credentials only, no apply yet), and inspects the audit trail.
- Account deletion + 30-day-grace simulation + DEK destruction makes prior PII unreadable (verified by automated test).
- No plaintext password / credential / MFA secret / PII appears in logs (verified by redaction unit tests).
- A worker can request a credential lease and successfully redeem it against a mock platform target.
- All four S1 audit blockers have a passing test or check.

---

## Phase 2 — LinkedIn end-to-end + scheduler service (formerly M2 + new scheduler)

### Objective

A user runs LinkedIn-only end-to-end with target-20 applications, observably and durably, with the scheduler service operational and owning the maintenance crons used by this phase.

### Deliverables

**Automation engine:**
- `packages/automation-core` with `BrowserPool`, `BasePlatformAdapter`, anti-detection layers (identity profile generator, behavior simulator, paste-vs-type detection per audit fix C3, memory pressure governor per audit fix C7).
- `packages/platform-adapters/linkedin` — `ensureSession`, `search`, `parseListing`, `parseJob`, `canApply`, `apply` (Easy Apply path first), `uploadResume`. Layered selectors with mandatory fallbacks.
- `apps/automation-worker` consuming `q:platform.discovery` and `q:platform.apply`, leasing credentials, persisting `applications` + `application_questions` + `application_files` + `application_events`. Adapter-version pinning per audit fix C5.

**Orchestration:**
- `apps/orchestrator` with the run state machine; single-platform mode only.
- Freshness ranking (t5h → t12h → t24h → t5d, > 5d discarded).
- Pause/resume/stop with completed-in-flight guarantee.
- Single-writer rule with **fencing tokens** (audit fix B4).
- `SELECT ... FOR UPDATE SKIP LOCKED` dispatch (audit fix B2).
- Outbox relay with per-aggregate FIFO (audit fix B7).
- `submitting` reaper with the activity-based criterion (audit fix B8).
- Dry-run mode (missing feature §5).
- Job dedupe across platforms scaffolding (missing feature §6) — useful here for re-runs.

**Scheduler service (new, missing feature §1):**
- `apps/scheduler` with `pg_advisory_lock` leader election.
- Owns: `pg_partman` partition rollover, `analytics_rollups` refresh, idempotency-key reaper, audit-chain verifier (daily), DR-drill ticket opener (audit fix G6), embedding-refresh queue drain.
- User-facing recurring runs framework (UI in Phase 4).

**Real-time:**
- Socket.IO with Redis adapter; `since` cursor replay; route-aware patching reducer (audit fix E1).
- Activity feed UI on Command Center.

**Database:**
- All Phase-3 tables added except multi-tenant fields (those land in Phase 7).
- Audit fix A2 (per-dim embedding tables) implemented from day one.
- Audit fix A7 (partition-ready but not yet applied to `application_questions`/`application_files`).
- Missing feature §10 schema (`feature_flags`, `feature_flag_rules`, `experiment_assignments`).
- Missing feature §15 (`tools/db-scrub/rules.yaml` covers every new column).

**Audit fixes folded in:**
- A1 (partial unique index now exercised).
- B5 (manual apply idempotency keys).
- B6 (rate-limit headers).
- C2 (fingerprint rotation policy).
- C4 (IP reputation tracking).
- G1 (coordinated Helm rollout for adapter version bumps).
- H1 (clock authority — orchestrator clock, NTP everywhere).

### Dependencies

Phase 1 complete.

### Risks

- LinkedIn variant divergence — mitigated by multiple variant flows + nightly canary.
- Anti-detection tuning sensitivity — locked profile generator + tuning runbook + headed dev mode for repro.
- Scheduler leader-election bugs cause double-firing of cron — mitigated by `pg_advisory_lock` and idempotent job design.

### Complexity

**Large** — 6 engineer-weeks. The biggest single phase; LinkedIn is the reference implementation for every later adapter.

### Exit criteria

- A real LinkedIn run with target-20 completes end-to-end, observable in real time, with zero duplicates and zero credential exposure.
- Pause respected within one application boundary; UI reflects state within 2s.
- Killing all worker pods mid-run does not double-submit.
- Apply success rate ≥ 80% on Easy Apply listings (50-listing test corpus).
- Scheduler runs all maintenance crons on schedule for 14 consecutive nights without manual intervention.

---

## Phase 3 — AI engine + Q&A memory + scoring (formerly M3, with audit fixes)

### Objective

The agent stops being a form-filler and becomes a judgment layer. Job scoring is calibrated; question answering is consistent; every decision is auditable; cost is bounded.

### Deliverables

- `apps/ai-service` with the gateway, RAG pipeline (HNSW for `qa_memory`/`frequent_answers`, IVFFlat for slow-churn — audit fix D2), prompt registry, decision audit, cost governor (atomic — audit fix B1), `MOCK` provider, real Anthropic provider, real embeddings provider.
- The five core prompts (`job.relevance.score`, `app.answer`, `resume.tailor`, `cover.letter`, `profile.review`) at v1, with Zod schemas, examples, and canonical eval suites. Two supporting prompts (`captcha.classify`, `qa.normalize`) — both **metered through the cost governor** (audit fix D1).
- Provider rate-limit pre-emptive backoff (audit fix D4).
- Resume tailor with per-section relevance pre-filter (audit fix D6).
- Profile review with cohort-quarantined calibration (audit fix D5; cohort table + default-global until ≥ 200 outcomes).
- Prompt-injection memory quarantine (audit fix D3).
- AI prompt safety classifier on outputs (missing feature §14).
- `qa_memory` re-embedding queue + trigger (audit fix D7).
- Better resume parser (ML-enhanced; replaces M1's basic parser).
- Eval harness gates merges to `packages/ai-core/prompts/**`.

### Dependencies

Phase 2 complete (orchestrator + worker call AI service).

### Risks

- Provider rate-limit surprises during eval bursts — `MOCK` provider + recorded responses keep CI hermetic.
- Cohort-quarantined calibration cold-start — explicit fall-through to global.

### Complexity

**Medium** — 4 engineer-weeks.

### Exit criteria

- Repeat-question hit rate on `qa_memory` ≥ 95% after first run on a 100-question corpus.
- Job scoring Spearman ≥ 0.7 vs human ratings on a labeled corpus; Brier < 0.20.
- Cost per submitted application within budget cap (≤ $0.05 default).
- All five prompts pass canonical evals at 100% and regression at ≥ 95%.
- Atomic cost governor proven correct under 50 concurrent calls (race test).

---

## Phase 4 — Frontend depth + scheduler UX + dry-run + analytics v1 (formerly M4 + missing features 5, 13, 15, 16)

### Objective

The web app becomes the cockpit it was specified to be; user-facing scheduling is live; dry-run is available before every real run; ops have telemetry.

### Deliverables

- Command Center with R3F hero (lazy-loaded, with audit fix E4 disposable scenes), live activity feed, today's metrics tiles, eligible-jobs preview.
- Job Stream (virtualized, freshness sort, score column, reasoning popover, URL-driven filters).
- Applications (pipeline + table + detail drawer with timeline, questions, screenshots, AI reasoning).
- Resumes (Studio + diff + PDF preview; permission strip).
- Profile (full read/write; sensitive fields behind step-up).
- Notifications drawer; toast system; Cmd-K command palette.
- Analytics v1 — Overview tab.
- **Recurring runs UI** — register a schedule; preview next 7 fires; pause/resume.
- **Dry-run** — first-class flag on the start-run dialog; the resulting run is clearly marked; no submissions occur.
- **Onboarding telemetry** (missing feature §13) — milestones tracked.
- **Outbound proxy auditing** pipeline (missing feature §15) — anomaly events visible in Operations dashboard.
- A11y: axe-core CI green on every key route; reduced-motion respected.
- Lighthouse CI with **baseline-pinned budgets** (audit fix E3).
- Forms autosave with logout-clear (audit fix E2).
- Email transactional system (missing feature §12) wired up; verification + transactional flows now use real provider.

### Dependencies

Phases 2 and 3 complete.

### Risks

- R3F bundle bloat — strictly lazy-loaded; reduced-motion fallback.
- WebSocket reconnect edge cases — covered by `since` cursor + audit fix E1.

### Complexity

**Medium-Large** — 5 engineer-weeks.

### Exit criteria

- Lighthouse budgets met on 4G mid-tier (LCP ≤ 1.8s, INP ≤ 100ms p95, main bundle ≤ 180KB gz).
- Zero WCAG 2.2 AA violations on Command Center, Job Stream, Applications, Resumes, Profile, Settings.
- Real-time event delivery p95 ≤ 500ms publish-to-render.
- 5 internal users complete an end-to-end run unaided and rate "what's happening right now" clarity ≥ 4/5.
- A scheduled run fires on time for 7 consecutive days.

---

## Phase 5 — Multi-platform + bulk + webhooks + safety classifier (formerly M5 + missing features 2, 4, 14)

### Objective

Three platforms (LinkedIn, Naukri, Indeed) sequenced under one run; bulk operations are durable; outbound webhooks deliver to user systems; AI safety classifier is in-line.

### Deliverables

- `packages/platform-adapters/naukri` to LinkedIn parity.
- `packages/platform-adapters/indeed` to LinkedIn parity (locale-branched flows).
- Orchestrator: multi-stage planning with `requested_platforms[]` ordered by canonical sequence; per-platform target counters; skip reasons (`no_account`, `platform_disabled`).
- Per-platform global token-bucket rate limit honored across users.
- Run-start dialog supports multi-platform.
- Per-platform autonomous mode and threshold overrides in Settings.
- **Bulk operations** (missing feature §4) — `bulk_operations` + items + UI.
- **Webhooks** (missing feature §2) — registration, signing, delivery worker, DLQ, audit.
- **AI prompt safety classifier** (missing feature §14) — quarantine pipeline.
- ATS-detector module (audit fix C6) — no ATS adapters yet, but skip reason becomes informative.
- Egress allowlist meta-patterns for ATS hosts (audit fix G5).

### Dependencies

Phase 4 complete.

### Risks

- Naukri's heavier multi-step apply forms — Q&A coverage corpus extends; one engineer dedicated to question taxonomy.
- Indeed's regional variance — adapter detects locale early.

### Complexity

**Medium** — 4 engineer-weeks.

### Exit criteria

- Multi-platform run targeting LinkedIn → Naukri → Indeed at 20 applications each completes in a single session, respecting freshness, with no duplicates across platforms (job-dedupe verified).
- Each adapter's offline test suite green; nightly canary green for 7 consecutive nights.
- Bulk withdraw of 50 applications is durable through a worker restart.
- A registered webhook receives `application.submitted` within 2s of the event (delivery latency p95).

---

## Phase 6 — Optimization + email ingestion + notifications + security rules (formerly M6 + missing features 3, 7, 9, 18)

### Objective

The agent acquires permission-gated power: it suggests, the user approves, the agent mutates. Status updates flow back from email. Notifications mature. Security telemetry drives action.

### Deliverables

- `apps/api` optimization endpoints (`/optimization/review`, approve, reject).
- AI service runs `profile.review`; suggestions land in `optimization_suggestions`.
- Resume tailoring as patch (Phase 7 §13 contract); approval surface in Resume Studio.
- Permission scopes enforced end-to-end; step-up MFA on grant.
- LinkedIn / Naukri / Indeed adapters add `applyProfileChange`.
- **Email ingestion** (missing feature §3) — inbox aliases, parser, application matcher, status update flow. Off by default; opt-in per user.
- **Notification breadth** (missing feature §9) — push + webhook + per-event matrix + quiet hours.
- **Customer-support consented impersonation** (missing feature §7).
- **Security rules engine** (missing feature §18) — drives lockouts, pauses, on-call pages.

### Dependencies

Phase 5 complete.

### Risks

- AI tailoring quality false-positives — patch-only output + explicit reviewer step.
- Email parser misclassification — confidence threshold + user override; never auto-update without ≥ 0.85 confidence.

### Complexity

**Medium-Large** — 5 engineer-weeks.

### Exit criteria

- 100% of mutations to `users` profile / `resumes` / `resume_versions` go through suggestion + approval; no API path bypasses.
- Tailoring eval: an `add_skill` op without supporting evidence is dropped 100% of the time; a `reword` introducing fabricated metrics is dropped 100% of the time.
- A user without `resume.edit.linkedin` cannot have AI tailor a resume bound to a LinkedIn application.
- Email-driven status updates achieve precision ≥ 0.95 on a hand-labeled corpus.
- Security rules engine pages on a synthetic credential-read-out-of-hours event in < 60s.

---

## Phase 7 — Analytics depth + remaining adapters + remote viewer + health board + status page (formerly M7 + M8 + missing features 8, 11, 17, 20)

### Objective

All eight platforms ship; mode-A finally has the human-takeover UX it was promised; analytics close the loop; trust is observable.

### Deliverables

- Adapters: `internshala`, `glassdoor`, `foundit`, `wellfound`, `upwork` (proposals).
- Per-platform pacing profiles tuned with telemetry from Phases 2 and 5.
- **Remote viewer service** — one-time-use signed link to a viewer-proxy that streams the worker's browser tab; user completes CAPTCHA; worker validates post-challenge state and continues.
- Analytics tabs: Funnel, Platforms, Resumes, Skills, Operations.
- Materialized views / `pg_partman` partitions + `pg_cron` refreshes (audit fix G4).
- Operations tab (owner-only): AI cost over time, validation failure rate, queue depths, captcha frequency, adapter version distribution.
- Score → outcome calibration job (cohort-aware).
- **Adapter / platform health board** (missing feature §8).
- **Public status page** (missing feature §11).
- **Application refresher / second pass** (missing feature §17) — closes the funnel data.
- **Data export schedule + retention transparency** (missing feature §20).
- HNSW vs IVFFlat decision applied per corpus (audit fix D2 fully realized now).

### Dependencies

Phase 6 complete.

### Risks

- Remote viewer security — signed URL TTL = 5 min, scoped, viewer in isolated namespace; pen-test focus area.
- Glassdoor's frequent ATS handoffs — telemetry visible via §6; no ATS adapter yet (M9 follow-up).
- Wellfound / Upwork divergence — Upwork "apply" is "send proposal"; cover-letter prompt branches.

### Complexity

**Large** — 6 engineer-weeks.

### Exit criteria

- All eight platforms green offline + 14 consecutive canary nights.
- A user completes a CAPTCHA via remote viewer in < 60s and the run continues without restart.
- End-to-end run hitting all eight platforms with target-10 each completes within 6 hours, within daily AI budget.
- Status page reflects an injected synthetic incident within 60s.
- Analytics tiles match raw queries to within 0.1%.

---

## Phase 8 — Hardening, multi-tenant, compliance, billing (formerly M9–M10)

### Objective

The platform becomes a product; the product becomes operable; the operator becomes accountable. Public beta opens.

### Deliverables

- **Multi-tenant** — `tenant_id` on every user-owned table; RLS policies enforce tenant scoping; `app.tenant_id` set per session.
- RLS on `audit_log` (per-tenant chain heads exposed read-only to the tenant, write-only to the system).
- **Per-tenant cost attribution** (missing feature §16).
- Quotas per tenant (concurrent runs, daily applications, AI spend).
- Admin UI for tenant administration.
- **Stripe billing** with metered usage (AI cost + applications submitted); trial → paid → dunning → suspension flows.
- **Compliance scaffolding** — SOC 2 control catalog mapped to telemetry; vendor management register; data residency configurable per tenant.
- **External penetration test** by an outside firm; remediation tracked.
- **Chaos drills** scheduled — toxiproxy + pumba; SLO compliance verified.
- Runbooks completed in `docs/runbooks/`.
- ATS adapters v0 — Workday / Greenhouse / Lever (read-only first; apply paths in a follow-up).
- Hindi locale (locale framework already in Phase 1; this phase ships translations).
- PWA shell (offline shell only; agent stays server-side).
- Public beta with capped seats; on-call rotation; incident review cadence; NPS survey at week 4.

### Dependencies

Phase 7 complete.

### Risks

- RLS retrofit — extensive cross-tenant probe in CI; canary tenant before general availability.
- Pen-test findings volume — schedule remediation buffer (~2 weeks).
- Stripe edge cases (proration, refunds, VAT/GST) — scoped to launch tier; advanced cases in follow-up.

### Complexity

**Large** — 6 engineer-weeks (plus pen-test remediation buffer).

### Exit criteria

- Two tenants on the same cluster cannot read each other's data via any code path; automated cross-tenant probe in CI confirms.
- Pen-test report shows no high/critical findings; mediums tracked with closure dates.
- Chaos drills pass with all SLOs respected; RTO ≤ 30 min verified by real PITR-from-cold-backup drill.
- Stripe handles trial / paid / dunning / suspension flows in staging.
- All Phase-9 alerts have linked runbooks; alert noise rate < 1 false-positive page/week.
- SOC 2 Type 1 readiness audit passes.
- 99.5% of submitted applications complete within retry policy; median user submits ≥ 50 applications in their first week without intervention; NPS ≥ 40.

---

## Path summary

| Phase | Theme | Eng-weeks | Cum. weeks | New services | New tables (cum.) |
| --- | --- | --- | --- | --- | --- |
| 1 | Foundations + S1 fixes | 5 | 5 | API, web (skeleton) | 11 |
| 2 | LinkedIn E2E + scheduler | 6 | 11 | + orchestrator, worker, scheduler | ~50 |
| 3 | AI core + Q&A memory | 4 | 15 | + ai-service | ~58 |
| 4 | Frontend depth + dry-run + analytics v1 | 5 | 20 | + analytics | ~64 |
| 5 | Multi-platform + bulk + webhooks | 4 | 24 | — | ~70 |
| 6 | Optimization + email ingest + notifications | 5 | 29 | + (email-ingest module) | ~73 |
| 7 | All platforms + remote viewer + analytics depth | 6 | 35 | + remote-viewer | ~74 |
| 8 | Hardening + multi-tenant + compliance + billing | 6 | 41 | — | ~74 |

**Critical path: ~32 weeks (Phases 1–7).** Phase 8 is sequencable into a hardening period with parallel pen-test and SOC 2 prep.

The audit's S1 blockers all land in Phase 1. The S2 material findings each have a phase owner above. The S3 refinements are written into the relevant phase's exit criteria; nothing is left to "we'll get to it."
