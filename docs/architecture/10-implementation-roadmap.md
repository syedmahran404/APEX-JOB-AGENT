# Phase 10 — Implementation Roadmap

## 1. Goals of this roadmap

Turn the design from Phases 1–9 into a sequence of milestones that:

- Has a **demonstrably working slice** at the end of every milestone — never "a six-month tunnel."
- Front-loads **risk** (security, durability, single-platform end-to-end) before breadth (more platforms, more polish).
- Defers **scope that depends on real usage** until there is real usage to learn from (calibration, peer norms, multi-tenant).
- Attaches **measurable exit criteria** to every milestone, not "feels done."
- Keeps the **architecture commitments** intact at every step; we don't backslide on encryption, audit, or permissions to ship faster.

The roadmap covers M0 through M10. Each milestone names: scope, exit criteria, the dependencies that gate it, the new risks it introduces, and the rollout posture.

---

## 2. Milestone summary

| Milestone | Theme | Outcome | Typical duration† |
| --- | --- | --- | --- |
| M0 | Foundations | Empty monorepo runs locally; CI green; migrations + Vault + observability online | 2 weeks |
| M1 | Identity + Vault + Profile | A user can sign up with WebAuthn, complete onboarding, and have credentials sealed in the vault | 3 weeks |
| M2 | LinkedIn end-to-end | One platform discovers + applies under the orchestrator; UI shows the run in real time | 4 weeks |
| M3 | AI core + Q&A memory + scoring | Job scoring, consistent question answering, decision audit, cost governor | 3 weeks |
| M4 | Frontend depth + analytics v1 | Command Center, Job Stream, Applications pipeline, Analytics overview | 3 weeks |
| M5 | Naukri + Indeed adapters; Multi-Platform mode | Three platforms sequenced by a single run | 3 weeks |
| M6 | Profile + Resume optimization (gated) | Suggest-then-approve UX; tailor-as-patch; permission scopes wired end-to-end | 3 weeks |
| M7 | Analytics depth + Operations dashboards | Funnels, platforms, resumes, skills, ops; real-time tiles | 2 weeks |
| M8 | Internshala + Glassdoor + Foundit + Wellfound + Upwork + remote-viewer | All eight platforms; mode-A human takeover via remote viewer | 5 weeks |
| M9 | Hardening + Multi-tenant + Compliance | Chaos drills, SOC 2 controls, RLS-based multi-tenant, billing surface | 5 weeks |
| M10 | Beta launch | Real users; daily-use validation; on-call rotation; incident response loop closed | 4 weeks |

† Durations assume a small focused team (3–5 engineers + 1 designer + part-time SRE). They are pacing targets, not contracts.

Total roadmap to beta: ~37 weeks. Critical-path items (M2 LinkedIn, M3 AI core, M8 remote-viewer, M9 multi-tenant) carry the most risk.

---

## 3. M0 — Foundations

**Theme:** turn an empty repo into a clean, observable, secure platform where every later milestone has somewhere to land.

### Scope

- pnpm + Turborepo monorepo skeleton (Phase 2 layout).
- TypeScript strict, ESLint with custom boundary rules (`apex/no-cross-app-imports`, `apex/app-uses-package-only`, `apex/package-declared-deps`, `apex/no-secrets-in-source`, `apex/zod-only-in-shared-types`, `apex/error-class-from-shared-errors`, `apex/no-direct-prisma-in-apps`).
- `packages/shared-config`, `packages/shared-logger`, `packages/shared-errors`, `packages/shared-types` initialized with the conventions from Phases 4 and 8.
- `packages/db` with Prisma schema (initial subset: `users`, `roles`, `permissions`, `platforms`, `audit_log`), pgvector + pg_partman + pgcrypto + citext extensions, hash-chain trigger, seed for static data.
- `packages/crypto` and `packages/vault-client` with the envelope-encryption primitives and lease helpers.
- `packages/queue` (BullMQ wrappers), `packages/realtime` (Socket.IO conventions), `packages/testing`.
- `apps/api` boots with `/healthz` and `/readyz`; CSP/HSTS/CORS configured; Pino + OTel wired.
- `apps/web` boots with the design-token base, an empty Command Center route, and the API client codegen.
- `infra/compose/dev.compose.yaml` brings up PG, Redis, MinIO, Vault dev, MailHog, OTel collector.
- `infra/docker/*.Dockerfile` shells for each app (multi-stage, digest-pinned bases).
- CI: `ci.yaml` runs install/typecheck/lint/test/build; OpenAPI drift check; gitleaks; osv-scanner.
- Observability: Grafana, Loki, Tempo, Prometheus stacks in dev; baseline dashboards for golden signals and queue depths.
- ADRs documenting D-01 through D-20 from `00-overview.md` as separate `docs/adr/0001-*.md` … `0020-*.md`.

### Exit criteria

- `git clone && pnpm i && pnpm dev` brings a green stack up in < 5 minutes on a clean machine.
- CI is green on a no-op PR; lint, typecheck, unit tests, and OpenAPI check all pass.
- Migrations apply cleanly to a fresh PG; the audit hash chain trigger blocks UPDATE/DELETE on `audit_log`.
- A round-trip "encrypt then decrypt with per-user DEK" unit test passes against the dev Vault.
- A demo user is seedable from `pnpm seed`.

### Dependencies / risks

- Vault dev-mode quirks (different seal model than prod) — `packages/vault-client` abstracts both.
- pgvector dimension choice (1024) committed at this point; embedding model is selected at M3.

### Rollout

- Internal only. No public surface.

---

## 4. M1 — Identity, Vault, Profile

**Theme:** the user exists, is protected, and has uploaded their professional life.

### Scope

- WebAuthn primary + email/password fallback + TOTP secondary; recovery codes.
- Sessions (`__Host-` cookie + DB hash + revocation Pub/Sub).
- Step-up MFA guard for sensitive endpoints.
- RBAC + permission scope guards.
- Credential vault flow (UI-side modal + API-side seal).
- Onboarding wizard (5 steps) end-to-end:
  - Welcome / consent.
  - Resume upload + parser → `resumes`/`resume_versions`/`resume_files`.
  - Profile facts (educations, experiences, projects, skills, links, personal info).
  - Preferences.
  - Connect platforms (creates `platform_accounts` and seals `platform_credentials`).
- `audit_log` populated for every consequential action.
- Activity (audit timeline) UI page in read-only form.
- `POST /me/export` and `DELETE /me` (with grace + DEK destruction) implemented.
- Settings → Security: factors, recovery codes, sessions list with revoke.

### Exit criteria

- A new user can sign up, enroll WebAuthn, finish onboarding, connect at least LinkedIn (credentials only — no apply yet), and see an audit trail of every action.
- Deleting the account marks `users.deleted_at`; after 30 simulated days the reaper destroys the DEK and ciphertext becomes unreadable. A reverse-operation test confirms unreadability.
- Penetration spot-check (internal): no plaintext password, credential, MFA secret, or PII appears in any log line; redaction unit tests confirm.
- The orchestrator and worker can request a credential lease and successfully redeem it (mock platform target) — without any other component ever holding plaintext.

### Dependencies / risks

- WebAuthn library choice (open source `@simplewebauthn/server` + `@simplewebauthn/browser`) — chosen here.
- Resume parser: we ship M1 with a basic structured parser (text + heuristics); ML enhancement is pushed to M3.
- Vault prod profile is not yet exercised — that gate is at M9.

### Rollout

- Closed alpha to a handful of internal users with no automation enabled.

---

## 5. M2 — LinkedIn end-to-end

**Theme:** one platform, end-to-end, durable. The hardest milestone; everything after compounds on it.

### Scope

- `packages/automation-core` with `BrowserPool`, `BasePlatformAdapter`, anti-detection layers (identity / behavior).
- `packages/platform-adapters/linkedin` with `ensureSession`, `search`, `parseListing`, `parseJob`, `canApply`, `apply` (Easy Apply path first), `uploadResume`.
- `apps/automation-worker` consuming `q:platform.discovery` and `q:platform.apply`, leasing credentials, persisting `applications`, `application_questions`, `application_files`, `application_events`.
- `apps/orchestrator` with the run state machine: `pending → planning → running → paused | stopped | done`. Single-platform mode only.
- Freshness ranking inside discovery (t5h → t12h → t24h → t5d), discarding > 5d.
- Pause / resume / stop semantics with completed-in-flight guarantee.
- Real-time fan-out via Pub/Sub → Socket.IO → Command Center activity feed.
- CAPTCHA / OTP detection with mode-A pause and notification (mode-B too: skip with reason). No remote viewer yet — mode-A surfaces a notification and the user resumes after self-service handling.
- Single applications screen (kanban) showing live status changes.

### Exit criteria

- A new user with LinkedIn credentials can run a single-platform run with a target of 20 applications, on a real LinkedIn account in a sandbox tenant, and the agent submits applications observably with zero duplicates and zero credential exposure.
- A pause request is honored within one application boundary and the dashboard reflects "paused" within 2 seconds.
- Killing all worker pods mid-run and restoring them does not double-submit (idempotency holds).
- Selector drift in any single step yields a captured DOM snapshot + screenshot + a flagged adapter version.
- Apply success rate ≥ 80% on Easy Apply listings against a 50-listing test corpus.

### Dependencies / risks

- LinkedIn's apply UI A/B variants. Adapter ships with at least two known variants supported and a "fallback to general apply" branch.
- Anti-detection tuning. We tune against a controlled session and lock the profile generator before public alpha.

### Rollout

- Internal alpha; the LinkedIn adapter version (`v0.1`) is pinned and visible in `applications`.

---

## 6. M3 — AI core, Q&A memory, scoring

**Theme:** the agent stops being a form-filler and becomes a judgment layer.

### Scope

- `apps/ai-service` with the gateway, RAG pipeline, prompt registry, decision audit, cost governor, `MOCK` provider, real Anthropic provider, real embeddings provider.
- The five core prompts (`job.relevance.score`, `app.answer`, `resume.tailor`, `cover.letter`, `profile.review`) shipped at v1 with their Zod output schemas, examples, and canonical eval suites.
- `qa_memory` with normalize → lookup → hybrid retrieval; `frequent_answers` with `is_locked` honored.
- `embeddings` populated for `frequent_answers`, `qa_memory`, `work_experiences`, `projects`, `user_skills` clusters, current `resume_versions`.
- `ai_decisions`, `ai_cost_ledger`, `ai_eval_results` populated and visible in the AI Operations dashboard.
- Job scoring pipelined into discovery; threshold honored; `applications.ai_score` populated.
- Question answering integrated into the worker: `question.encountered` events flow through the AI service; answers are validated against field constraints; low-confidence answers route per mode (assisted vs autonomous).
- Cost governor with per-user daily ceiling and downgrade-then-skip behavior.
- Knowledge tab in the UI: Frequent Answers + Q&A Memory.
- Eval harness in `tools/eval-harness/` runs on every `packages/ai-core/prompts/**` change in CI.

### Exit criteria

- Across a 100-question corpus, repeated invocations of the same question hit `qa_memory` ≥ 95% after first run, and answers are byte-identical to the canonical answer.
- Job scoring against a labeled corpus reaches ≥ 0.7 Spearman with human ratings; the scoring distribution is well-calibrated (Brier < 0.20).
- Cost per submitted application stays within the M3 budget cap (e.g., $0.05) across the eval suite.
- Eval suites for all five prompts pass at 100% (canonical) and ≥ 95% (regression) under v1 prompts.
- An end-to-end test answers a 12-question application without human intervention in mode B.

### Dependencies / risks

- Provider rate limits during eval bursts. Mitigated by `MOCK` provider and recorded responses.
- Calibration data scarcity early; we bootstrap calibration with a hand-labeled set, refresh post-M5.

### Rollout

- Internal alpha; AI features visible to onboarded users; cost ceiling default $0.50/day.

---

## 7. M4 — Frontend depth + Analytics v1

**Theme:** the UI becomes the cockpit it was specified to be.

### Scope

- Command Center hero (R3F particles), live activity feed, today's metrics, eligible-jobs preview, suggestions snippet (placeholder until M6).
- Job Stream with virtualization, freshness sort, score column, reasoning popover, URL-driven filters.
- Applications: pipeline + table; detail drawer with timeline, questions, screenshots, AI reasoning.
- Resumes: list + Studio (versioned editor + diff + PDF preview); permission strip (toggle wired but not yet acted upon).
- Profile: full read/write per group; sensitive group hidden behind step-up MFA.
- Notifications drawer; toast system; command palette (Cmd-K).
- Analytics v1 — Overview tab only: applications time series + response rate + 24h activity; per-platform tile.
- A11y: axe-core CI green on every key route; reduced-motion respected.
- Performance budgets enforced by Lighthouse CI on every PR.

### Exit criteria

- All performance budgets met on a 4G mid-tier device (LCP ≤ 1.8 s, INP ≤ 100 ms p95, main bundle ≤ 180 KB gzipped).
- Axe-core finds zero WCAG 2.2 AA violations on Command Center, Job Stream, Applications, Resumes, Profile, Settings.
- Real-time pipeline never lags > 500 ms p95 from event publish to UI render in the staging soak.
- A user-test session with 5 internal users completes an end-to-end run without tutorial and rates "what's happening right now" clarity ≥ 4/5.

### Dependencies / risks

- R3F bundle size; resolved by lazy loading and reduced-motion fallback.
- WebSocket reconnect edge cases; covered by the `since` cursor replay endpoint.

### Rollout

- Closed beta to a curated list of users with LinkedIn-only mode.

---

## 8. M5 — Naukri + Indeed; Multi-Platform mode

**Theme:** breadth begins. Sequencing of platforms inside a single run becomes real.

### Scope

- `packages/platform-adapters/naukri` and `packages/platform-adapters/indeed` to LinkedIn parity (search, parse, canApply, apply Easy Apply or quick variants, uploadResume).
- Orchestrator gains multi-stage planning: `requested_platforms[]` ordered by canonical sequence; per-stage dispatch; per-platform target counters; `skipped` reasons (`no_account`, `platform_disabled`).
- Per-platform global token-bucket rate limit honored across users.
- Frontend run-start dialog supports selecting platforms and a target per platform.
- Platforms tab in Settings supports per-platform autonomous mode and threshold overrides.

### Exit criteria

- A multi-platform run targeting LinkedIn → Naukri → Indeed at 20 applications each completes in a single session, respecting freshness rules, with no duplicate applications across platforms (a job from a multi-poster is applied to once).
- Each adapter's offline test suite (against fixtures) is green.
- Each adapter's nightly canary against the live site has run successfully for 7 consecutive nights before "general availability" within beta.

### Dependencies / risks

- Naukri's heavier multi-step apply forms may require more question-answering coverage; prompt corpus extended in M5.
- Indeed's regional variance handled by detecting locale early in the adapter and branching.

### Rollout

- Beta widening; Naukri/Indeed flagged "preview" to set expectations during initial canary.

---

## 9. M6 — Optimization Engine (gated)

**Theme:** the agent gets a permission-gated power: it can suggest, and on approval it can mutate.

### Scope

- `apps/api` optimization endpoints: `POST /optimization/review`, `POST /optimization/{suggestion_id}/approve|reject`.
- AI service runs `profile.review` against a profile snapshot; suggestions land in a new `optimization_suggestions` table.
- Resume tailoring: `resume.tailor` returns a patch; backend applies patch ops to a new `resume_versions` row with `source = 'ai_tailored'`, `approved_at = NULL`.
- Frontend Optimization inbox; per-card Approve / Reject; Resume Studio renders patch diff.
- Permission scopes enforced end-to-end: `profile.edit`, `resume.edit.global`, `resume.edit.<platform>`, `ai.tailor.*`. Each requires step-up MFA to grant.
- LinkedIn / Naukri / Indeed adapters add `applyProfileChange` (gated by capability + permission).
- The orchestrator considers tailored, approved resume versions per (resume, job) when applying.

### Exit criteria

- 100% of mutations to `users` profile, `resumes`, `resume_versions` go through the suggestion + approval pipeline; no API path bypasses.
- Approving a suggestion writes both the change and an `audit_log` entry within the same transaction; rejecting captures a reason.
- AI tailoring eval suite: an `add_skill` op without supporting evidence is dropped 100% of the time; a `reword` introducing fabricated metrics is dropped 100% of the time.
- A user without `resume.edit.linkedin` cannot have AI tailor a resume bound to a LinkedIn application; the run logs the skip reason and continues.

### Dependencies / risks

- AI tailoring quality; mitigated by patch-only output and an explicit reviewer step.
- UX for diffs; design pass at the start of M6.

### Rollout

- Beta users opt in to optimization; default is off.

---

## 10. M7 — Analytics depth + Operations

**Theme:** the agent's effectiveness becomes legible.

### Scope

- Analytics tabs: Funnel, Platforms, Resumes, Skills, Operations.
- Materialized views / continuous aggregates for the rollups; nightly reaggregation job.
- Operations tab visible to `owner` role only: AI cost over time, validation failure rate, queue depths, captcha frequency, adapter version distribution.
- Score → outcome calibration job: weekly recalibration based on response/shortlist/interview/offer signals.
- Ops alerts wired from Prometheus → Slack/PagerDuty per the catalog in Phase 9 §9.3.
- Adapter canary alerts feed into a "Selector drift" board the team triages weekly.

### Exit criteria

- Analytics tiles match raw `applications` queries to within 0.1% on a known dataset.
- Calibration job improves Brier score by ≥ 5% relative to M3 baseline on a held-out set.
- Ops dashboard surfaces an injected fault (a fake selector drift) within 10 minutes of injection during a drill.

### Dependencies / risks

- Some materialized views become hot at scale; we plan partition-aware refresh from the start.

### Rollout

- Beta widening; calibration improvements visible to existing users immediately.

---

## 11. M8 — Remaining adapters + remote viewer

**Theme:** all eight platforms are live, and mode-A finally has the human-takeover UX it was promised.

### Scope

- Adapters: `internshala`, `glassdoor`, `foundit`, `wellfound`, `upwork` (proposals).
- Glassdoor's frequent ATS handoffs handled with a defined "skipped_external_ats" outcome and a follow-up task to add Workday/Greenhouse/Lever adapters in M9+.
- Wellfound / Upwork: Upwork's "apply" semantically becomes "send proposal"; cover-letter prompt branches accordingly.
- Remote viewer service: when a worker emits `human-required` in mode A, the user receives a notification with a "Take over" button. Clicking opens a one-time-use, signed link to a remote-viewer page that streams the worker's browser tab (via Playwright's CDP-over-WebSocket through a thin viewer proxy). User finishes the challenge; worker validates the post-challenge state and continues.
- Per-platform pacing profiles tuned with telemetry from M2/M5.
- "External ATS skip" surfaced as a discrete metric on the Platforms tab.

### Exit criteria

- All eight platforms have green offline tests + 14 consecutive nights of clean canary runs.
- A user can complete a CAPTCHA via the remote viewer in under 60 seconds and have the run continue without restart.
- Each adapter has at least two pacing profiles (`STRICT_DEFAULT`, `BALANCED`) tuned and selectable per platform in Settings.
- End-to-end run hitting all eight platforms with target=10 each, on a sandbox identity, completes within 6 hours and stays inside daily AI cost budget.

### Dependencies / risks

- Remote viewer security: signed URL TTL = 5 minutes, scoped to a single `(user, run, application)`; viewer process is in its own isolated namespace.
- Upwork has the most divergent flow; cover-letter and pricing inputs need their own validation rules.
- Glassdoor often redirects; we accept "skipped_external_ats" rates of 30–50% during M8 and address with ATS adapters in M9+.

### Rollout

- Open beta with all eight platforms; remote viewer behind a feature flag for the first week to canary.

---

## 12. M9 — Hardening, multi-tenant, compliance, billing

**Theme:** the platform becomes a product; the product becomes operable; the operator becomes accountable.

### Scope

- **Multi-tenant**: `tenant_id` added to every user-owned table; PostgreSQL Row-Level Security policies enforce tenant scoping; the application sets `app.tenant_id` per session.
- **RLS on `audit_log`**: tenant-scoped reads, app-wide writes.
- **Quotas per tenant** (concurrent runs, daily applications, AI spend); admin UI for tenant administration.
- **Billing**: Stripe integration for paid tiers; metered usage feed from `ai_cost_ledger` + `applications` counts.
- **Compliance scaffolding**: SOC 2 control catalog mapped to existing telemetry; vendor management register; data residency configurable per tenant.
- **Penetration test** by an external firm; findings remediated.
- **Chaos drills**: scheduled toxiproxy + pumba runs in staging — kill orchestrator, drop Redis, fault PG primary, partition the workers' egress; SLOs verified.
- **Runbooks** completed in `docs/runbooks/` (KMS unreachable, audit chain break, mass selector drift, anomaly spike, ransomware on host, lost backup key, AI provider compromise).
- **ATS adapters v0**: Workday, Greenhouse, Lever (read-only first; apply in v1 of those adapters in a follow-up).
- **i18n**: Hindi locale shipped; locale-aware analytics formatting.
- **PWA** shell (offline shell only; the agent itself remains server-side).

### Exit criteria

- Two tenants on the same cluster cannot read each other's data via any code path; an automated cross-tenant probe in CI confirms.
- Pen-test report shows no high/critical findings; mediums tracked with closure dates.
- Chaos drills pass with all SLOs respected; RTO ≤ 30 minutes verified by a real PITR-from-cold-backup drill.
- Stripe integration handles trial, paid, dunning, and tenant suspension flows in staging.
- All Phase 9 alerts have linked runbooks; alert noise rate < 1 page/week false-positive.
- SOC 2 readiness audit (Type 1) passes with documented controls.

### Dependencies / risks

- RLS retrofit: we already designed for it (every row carries `user_id` and is grouped by it); the lift is policy authoring + extensive integration tests.
- Billing surface area is large; we ship the smallest set that supports the launch tier.

### Rollout

- Final closed beta with multi-tenant; SOC 2 Type 1 attained near M9 close.

---

## 13. M10 — Beta launch

**Theme:** real users, real outcomes, real on-call.

### Scope

- Public beta with capped seats per tenant during the first month.
- 24/5 on-call rotation; PagerDuty schedules; weekly incident review.
- "Offer received" celebration moment in the UI (animation + share-friendly summary; opt-in only).
- Help center, FAQ, security FAQ, status page integration.
- Adapter canary results visible to users on the Platforms tab so trust is observable.
- Public changelog; release notes auto-posted to the Activity tab.

### Exit criteria

- 99.5% of submitted applications complete within retry policy across the user population (measured weekly).
- Median user submits ≥ 50 applications in their first week without intervention.
- p95 incident response time for SEV1 ≤ 15 minutes; SEV2 ≤ 60 minutes.
- NPS ≥ 40 from beta users surveyed in week 4.

### Dependencies / risks

- The pacing profiles, anti-detection tuning, and AI calibration are at this point informed by months of telemetry. The largest risk is **platform countermeasures**; we lean on the canary system, the runbook for "mass selector drift," and the option to gracefully pause an adapter without taking the rest down.

### Rollout

- Soft launch first, then progressive expansion; per-platform feature flags allow disabling any single platform without redeploy.

---

## 14. Working agreements that span the roadmap

These hold across every milestone; they are part of the contract.

- **Definition of Done** for any feature: tests (unit + integration as applicable), telemetry (logs + metrics + traces), error paths, accessibility (if user-facing), documentation in the relevant phase doc or ADR, runbook entry if it can fail in production.
- **No feature without telemetry.** A merged PR that adds a code path without a metric or log is a bug.
- **No mutation of user data without an audit row.** Enforced in code review and by `apex_app` DB role's restricted permissions on `audit_log`.
- **No prompt change without an eval result.** Enforced in CI.
- **No new platform adapter without offline tests + canary slot.** Enforced in CI.
- **No selector path without a fallback.** Layered selectors are required by the linter rule on the `selectors.ts` file in each adapter.
- **No bypass of permission scopes.** Enforced by repository helpers and code review.
- **Every release is rollback-safe.** Migrations forward-compatible; images immutable.
- **Bus-factor**: at least two engineers must have shipped to each high-risk area (auth, crypto, vault, orchestrator, each adapter family) before that area is considered "covered" for on-call.

## 15. Risk log (rolling)

| Risk | Phase that addresses it | Containment if it fires |
| --- | --- | --- |
| LinkedIn variant divergence | M2, M5 | Multiple variant flows + nightly canary; pause the platform if drift > threshold |
| Anti-detection arms race | M2, M5, M8 | Pacing profile updates; remote viewer for mode-A; conservative defaults |
| AI cost spike | M3, M7 | Cost governor; per-user ceiling; tier downgrade |
| Selector drift across adapters | All adapter milestones | Layered selectors; canary; hotfix-only adapter-version bumps |
| User account flagged by platform | M2 onward | Conservative pacing; one-session-per-identity; immediate stop on `permanent.account` |
| Vault outage | M0–M9 | Cached DEKs in memory continue serving live sessions; new logins refused; alert |
| Backup leak | M9 | Backups encrypted with `kek/backups`; rotation policy; quarterly drill |
| Multi-tenant data crossover | M9 | RLS + automated cross-tenant probe in CI; security event on any policy denial |
| Compliance findings | M9, M10 | Track-to-close with deadlines; pre-empt with internal pen-test in M9 mid-cycle |

## 16. After M10

The roadmap deliberately does not extend past M10 because the right next steps depend on what real users teach us. Likely directions:

- **More ATS adapters** (Workday/Greenhouse/Lever apply paths, then SmartRecruiters, Ashby).
- **Cohort-aware peer norms** for `profile.review` once the user base supports privacy-preserving aggregation.
- **Tool-using AI** for in-DB lookups (skill catalog, salary comparables) under tight allowlists.
- **Mobile native shells** if telemetry shows demand.
- **Multi-region** if user distribution requires.

Whatever the choice, every step continues to satisfy the non-negotiables from `00-overview.md`. That is the durable shape of this product.
