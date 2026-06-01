# Phase 6 — Automation Engine

## 1. Goals and constraints

The automation engine is the part of the system that touches the outside world. Every other layer can be re-run; this one cannot. A misclick here can submit a real application or, worse, get a user's account flagged. So the engine is designed around three constraints, in priority order:

1. **Safety of the user's account.** Never act in a way that looks automated; never exceed human-equivalent rates; never operate two simultaneous sessions on the same identity; never bypass platform consent screens.
2. **Determinism under drift.** Job sites change weekly. Selector drift, layout shifts, A/B tests, and silent feature flags must surface as recoverable errors, not silent failures.
3. **Speed within those bounds.** Once safety and determinism are honored, every millisecond is fair game.

The engine is also bounded by what it must not do:
- It does not create accounts on the user's behalf.
- It does not solve CAPTCHAs (human or third-party). It detects them and yields.
- It does not scrape data outside the user's authenticated session.
- It does not pretend to be a different user; it is the user's session, automated.

## 2. Stack

| Concern | Choice | Why |
| --- | --- | --- |
| Browser engine | Chromium via Playwright | Best ergonomics, parallel contexts, mature network/route control, first-class headed/headless. |
| Browser hardening | `playwright-extra` + `puppeteer-extra-plugin-stealth` (compatible) + custom hardening | Standard fingerprint corrections; we layer our own on top. |
| Concurrency | BullMQ workers | Same queueing fabric as the rest of the backend; Phase 4. |
| HTML parsing | Native DOM + `node-html-parser` for offline fixtures | Avoid JSDOM overhead in worker hot path. |
| Screenshots | Playwright's PNG output, S3 uploaded | Server-side encrypted at rest. |
| DOM snapshots | `page.content()` truncated and gzipped | For forensic replay on selector drift. |
| Network observation | Playwright `route` + CDP `Network` events | For traffic accounting and anti-loop checks. |

Firefox and WebKit are tested in CI as smoke targets; production runs Chromium because every adapter ships and is tuned against it.

## 3. The adapter contract

Every platform implements the same interface, exported from `packages/automation-core`:

```ts
export interface PlatformAdapter {
  readonly key: PlatformKey;        // 'linkedin' | 'naukri' | ...
  readonly version: string;         // semver; bumped on selector change
  readonly capabilities: AdapterCaps;

  // Auth & session
  ensureSession(ctx: AdapterContext): Promise<SessionState>;
  refreshSession(ctx: AdapterContext): Promise<SessionState>;

  // Discovery
  search(ctx: AdapterContext, filters: SearchFilters): AsyncIterable<DiscoveredJob>;
  parseListing(ctx: AdapterContext, raw: unknown): DiscoveredJob;
  parseJob(ctx: AdapterContext, jobUrl: string): Promise<JobDetail>;

  // Application
  canApply(ctx: AdapterContext, job: JobDetail): Promise<ApplyEligibility>;
  apply(ctx: AdapterContext, job: JobDetail, plan: ApplicationPlan): AsyncIterable<ApplyEvent>;

  // Profile & resume (optional, gated by capabilities)
  reviewProfile?(ctx: AdapterContext): Promise<ProfileSnapshot>;
  applyProfileChange?(ctx: AdapterContext, change: ProfileChange): Promise<void>;
  uploadResume?(ctx: AdapterContext, file: Buffer, name: string): Promise<{platformResumeId: string}>;
}
```

Notes:
- `AdapterContext` is the worker-supplied bag with `page`, `context`, `vault`, `aiClient`, `logger`, `eventEmitter`, `clock`, `randomness`, and a per-task `cancellationSignal`.
- `apply()` is an async iterable so the worker streams `ApplyEvent`s (`step.started`, `step.field_filled`, `question.encountered`, `captcha.detected`, `submitted`, `error`) into its outbox in order, with each event committed before the next step runs. This is what makes the apply flow observable in real time and resumable from the last clean step.
- Adapters declare what they can do via `AdapterCaps` (`{ quickApply: boolean, multiStep: boolean, profileEdit: boolean, resumeUpload: boolean, ... }`). The orchestrator and AI service consult capabilities before forming intent; they never assume.
- The base class `BasePlatformAdapter` in `packages/automation-core` provides defaults for retries, screenshots, and event emission so each platform implementation focuses on selectors and flows.

## 4. Platform coverage matrix (target capabilities, M2–M8)

| Platform | Quick apply | Multi-step apply | Profile edit | Resume upload | Notes |
| --- | --- | --- | --- | --- | --- |
| LinkedIn | yes | yes | yes (gated) | yes | First adapter; most stable selectors via test ids in some flows. |
| Naukri | yes (limited) | yes | yes (gated) | yes | Heavy step-by-step apply forms. |
| Indeed | yes | yes | partial | yes | Region-dependent forms; we must detect locale. |
| Internshala | yes | yes | yes | yes | Common with student profiles; small forms. |
| Glassdoor | partial | yes | partial | yes | Often delegates to employer-specific forms (Workday, Greenhouse, Lever). |
| Foundit | yes | yes | yes | yes | Stable layouts. |
| Wellfound | partial | yes | yes | yes | Heavy JS app; we test against React state patterns. |
| Upwork | n/a (proposals) | yes | yes | yes | Different domain entirely; we treat "apply" as "send proposal". |

Each adapter ships with offline fixtures in `packages/platform-adapters/<x>/fixtures/` so its parsing and form logic can be tested in CI without touching the real site.

## 5. Browser pool and context lifecycle

The worker process owns a **BrowserPool** managed by `packages/automation-core/pool/`. Lifecycle:

1. Worker boot creates one `Browser` instance per adapter family (Chromium configured with the chosen anti-detection profile). Browsers are heavyweight; we reuse them.
2. For each task, the worker requests a `BrowserContext` keyed by `(user_id, platform_key)`. The pool either:
   - Reuses a warm context still under TTL (10 minutes idle), or
   - Restores one from a saved storage state in S3 (`platform_sessions.storage_uri`), or
   - Creates a fresh context (only on first use after a credential change or session expiry).
3. The worker creates a fresh `Page` per task; `Page`s are not reused across tasks even within the same context.
4. After the task, the storage state is persisted back to S3 (encrypted), the page is closed, and the context's TTL is reset.
5. Idle eviction: contexts past TTL are saved-and-closed. Browser-level eviction occurs at memory pressure thresholds (configurable per node).

Why one context per `(user, platform)` and not one per task: cookies, localStorage, fingerprint surfaces, and platform-side trust signals carry across the user's sessions. Throwing them away every task is both wasteful and *more suspicious* than reusing them.

Concurrency caps:
- One **active page** per `(user, platform)`. Enforced by the Redis semaphore from Phase 1.
- N parallel `(user, platform)` pairs per worker. N defaults to 4 and is tuned by node memory; 1 GB headroom per active context is the safe budget.
- A worker never serves two tasks for the same user simultaneously, even across platforms, because the user's IP fingerprint should not show two parallel platform sessions.

## 6. Anti-detection: principles and practices

We split anti-detection into three layers. Each is configurable and observable.

### 6.1 Identity layer — the static fingerprint

Goal: each user appears as a single, plausible, consistent device.

- **Per-user device profile**: a stable, generated set including UA string, platform, languages, timezone (matched to the user's stated timezone), `navigator.hardwareConcurrency`, `deviceMemory`, screen resolution, color depth. The profile is stored once per user and reused across runs; we do not rotate it randomly because rotation looks like fraud.
- **Storage state persistence**: cookies, localStorage, IndexedDB carried across runs.
- **Locale**: `Accept-Language` aligned with the user's preferred locale and the platform domain.
- **Webdriver flags**: `navigator.webdriver` masked; `chrome.runtime` realistic; permission API responses normalized; iframe contentWindow leaks patched. These are well-known signals and the playwright-extra stealth plugin handles most; we maintain a small `packages/automation-core/hardening/` overlay for the rest.

We do not falsify identity beyond what the platform's TOS already permits when a real user uses the platform via a real browser. We do not impersonate other users, modify GPS, or claim hardware that doesn't exist.

### 6.2 Network layer — what comes off the wire

- **No proxies by default.** The user's traffic goes through their own network. (Optional: power users may configure a personal residential proxy via Settings → Platforms; we never rent shared proxies on their behalf.)
- **TLS fingerprint**: Chromium's native fingerprint, unmodified.
- **Request headers**: only what the browser would send. We never inject `X-Automated-By` headers or similar.
- **Resource blocking**: we *do not* block ads/analytics on the platform's own domain — that itself is a fingerprint. We only block third-party trackers on irrelevant domains, conservatively.
- **Rate accounting**: every navigation is counted toward a per-platform token bucket; sustained rates stay within human-equivalent ceilings (≤ ~30 actions / minute / platform globally; per-user lower).

### 6.3 Behavior layer — how the page is touched

- **Mouse**: real mouse moves with Bezier-curved paths, slight overshoot, and dwell. Click points are jittered within the target's bounding box, not always center.
- **Keyboard**: per-character delays drawn from a distribution conditioned on key adjacency (faster between adjacent keys, slower for long jumps). Typos and corrections are *not* simulated; they hurt accuracy and aren't worth it.
- **Scroll**: animated scroll with easing; pause every 1–3 viewport heights for ~200–600 ms.
- **Tab/window focus**: respected. We treat losing focus as a yield point.
- **Time of day**: optional "human hours" mode confines automation to a window in the user's local timezone. Off by default; on by recommendation for sensitive accounts.
- **Per-platform pacing**: each adapter declares a pace profile (`min/median/max ms` per action class) that tracks observed human distributions. The worker honors it.

All three layers are turned up or down by an `AntiDetectionProfile` enum: `STRICT_DEFAULT`, `BALANCED`, `FAST` (used only for offline tests against fixtures).

## 7. Step model and event emission

Every adapter's `apply` method emits a stream of `ApplyEvent`s. The worker writes each event to `application_events` *before* taking the next step. This gives us:

- **Real-time UX**: the frontend sees fills and submissions as they happen.
- **Forensics**: a failed step's prior events tell us exactly where it broke.
- **Resumability**: on retry, the worker can fast-forward through completed steps if the platform's UI allows it (e.g., the apply form remembers state).

Canonical event shapes:

```ts
type ApplyEvent =
  | { kind: 'step.started';     step: string; ts: string }
  | { kind: 'field.filled';     field: string; valueRedacted: string; source: AnswerSource }
  | { kind: 'question.encountered'; question: string; fieldKind: FieldKind; expectsAi: boolean }
  | { kind: 'question.answered';   questionId: string; source: AnswerSource; aiDecisionId?: string }
  | { kind: 'screenshot';       uri: string; label: string }
  | { kind: 'captcha.detected'; provider?: string; locator: string }
  | { kind: 'human-required';   reason: 'captcha'|'otp'|'phone'|'email'|'security'; details?: string }
  | { kind: 'submitted';        externalApplicationId?: string; confirmation: 'http200+dom'|'dom-only'|'redirect-success' }
  | { kind: 'step.failed';      step: string; reason: string; recoverable: boolean }
  | { kind: 'rate-limited';     waitMs: number };
```

`valueRedacted` is the *redacted* form of any field value (e.g., `"+91-***-***-1234"`); the actual value appears only in `application_questions.answer` (which is itself encrypted at rest for sensitive answers).

## 8. CAPTCHA / OTP / verification handling

Detection is layered, not a single regex.

- **DOM heuristics**: known iframe sources (`google.com/recaptcha`, `hcaptcha.com`, `cloudflare-challenge`, etc.); known landmark texts ("verify you are human", "enter the code we sent").
- **URL heuristics**: known challenge paths per platform.
- **Timing heuristics**: a navigation that doesn't reach the expected URL within budget triggers a "did we land on a challenge?" inspection.
- **AI second opinion** (cheap classifier): a small Claude call with the page title, URL, and visible h1 returns one of `none|captcha|otp|phone|email|security|other` with confidence. Used only when DOM/URL heuristics are ambiguous, capped per session.

When detection fires:
- **Mode A (assisted)**: the worker emits `human-required`, screenshots the page, persists context state, releases the page (keeps the context warm), and pushes a notification. The orchestrator pauses the run. The user sees a "Take over" button in the dashboard that opens a small browser-tab launcher (in dev: Playwright headed via the local socket; in prod: a one-time signed link to a remote viewer service in M8). After the human completes the challenge, the user clicks "Resume"; the worker re-acquires the page, validates the success state, and continues.
- **Mode B (autonomous)**: the worker emits `human-required`, immediately marks the application `skipped_human_required`, captures the screenshot for audit, releases the page, and asks the orchestrator for the next task.

We never call third-party CAPTCHA solvers. That is both a security and a TOS-compliance line.

## 9. Discovery

The discovery flow per adapter:

1. Open the platform's search surface with the user's filters (query, location, remote kind, salary minimum, posted-within window).
2. **Always set the platform's sort to "newest"** when supported; otherwise we sort client-side by parsed `posted_at`.
3. Iterate listings, paginating until either:
   - We have enough scored above-threshold candidates to satisfy the run's per-platform target, or
   - The next page's listings fall outside the freshness window (we stop the moment a listing is older than 5 days), or
   - We hit a soft cap (200 listings) to bound discovery time.
4. For each listing, normalize via `parseListing()`, dedupe against `job_seen` for the user, and stream into the AI service's `score-jobs` batch endpoint (size 8–16).
5. The worker enqueues `apply` tasks for jobs at or above the threshold, in order: t5h first, then t12h, then t24h, then t5d. Within a tier, by AI score descending.

Discovery's correctness invariant: the adapter must report `posted_at` to within a tolerance such that the freshness tiering is reliable. Where the platform reports relative time ("posted 4 hours ago"), the adapter converts using the worker's clock; where the platform reports absolute time, we use it directly. Where the platform reports nothing useful ("recently"), we fall back to the page-fetch time and tag the listing `posted_at_uncertain = true`; the orchestrator treats uncertain listings as one tier worse than they look.

## 10. Application flow (apply.task)

The worker's apply path, abstracted:

```text
1. Acquire user-platform semaphore.
2. Pre-flight:
   - Confirm the application doesn't already exist for (user_id, job_id). If yes → no-op.
   - Confirm permission scopes still allow apply on this platform.
   - Confirm the chosen resume version is approved.
3. Open the job page; verify it is still live and within freshness window.
4. Call adapter.canApply():
   - 'quick' | 'multi_step' | 'external_redirect' | 'closed' | 'already_applied'
5. If 'closed' or 'already_applied': record applications row accordingly, ack.
6. If 'external_redirect': follow the redirect; if it lands on an unsupported ATS, mark 'skipped_external_ats' and ack (we add ATS adapters in M8).
7. Otherwise, iterate adapter.apply() events, persisting each, answering questions via AI service as they arise, uploading the chosen resume.
8. Submit. Wait for confirmation signal (HTTP + DOM).
9. Persist applications.status = 'submitted', upload final screenshot, write outbox event.
10. Release semaphore. Ack BullMQ.
```

The orchestrator's reaper handles cases where step 9 commits but step 10 fails to ack — the duplicate retry hits the unique constraint and is a no-op.

## 11. Question answering integration

For each `question.encountered` event, the worker sends the AI service:

```jsonc
{
  "userId": "...",
  "applicationId": "...",
  "platformKey": "linkedin",
  "questionRaw": "What is your expected annual salary?",
  "fieldKind": "text|number|select|radio|checkbox|file|date",
  "options": ["..."],         // when applicable
  "constraints": { "minLength": 0, "maxLength": 200 },
  "context": { "jobTitle": "...", "company": "...", "currency": "INR" }
}
```

The AI service:
1. Looks up `frequent_answers` and `qa_memory` first (deterministic).
2. If no confident match, runs RAG over the user's profile + prior answers and calls the appropriate prompt.
3. Returns `{ answer, source, confidence, aiDecisionId, sources[] }`.

The worker validates the answer against the field's constraints (length, options, regex). If validation fails, it logs and either retries with stricter prompt or, for low-confidence answers, emits `human-required` reason `policy:low-confidence` (only in mode A; mode B skips with reason).

Consistency: the AI service short-circuits to `qa_memory` when a normalized question matches a previous one; this is what gives the user "consistent answers across applications" without us needing to special-case it.

## 12. Resume upload

The worker:
1. Resolves the `resume_version_id` chosen by the orchestrator (the user's default unless tailoring is allowed and a tailored version exists for this job).
2. Downloads the file from S3 via a presigned, single-use URL.
3. Drives the platform's file input (`page.setInputFiles`) and waits for the upload progress signal.
4. Verifies the displayed filename matches expected.
5. Writes a `application_files` row referencing the same `resume_version_id`.

Resume upload requires `resume.edit.<scope>` only if the *flow asks the user to also edit the parsed copy on the platform*; pure upload is allowed by default.

## 13. Profile edits (gated)

Only triggered by an explicit user-approved suggestion, never by the discovery/apply flow. The worker:
1. Re-checks the approval (`optimization_suggestions.approved_at IS NOT NULL`) and the permission (`platform_permissions.allow_profile_edit = true`).
2. Drives the platform's profile editor.
3. Writes `audit_log` rows for each field changed.
4. Persists a "before"/"after" snapshot pair.

If the user has not granted profile-edit permission, the suggestion remains in the inbox indefinitely; we never bypass.

## 14. Failure taxonomy and recovery

| Class | Examples | Recovery |
| --- | --- | --- |
| `transient.network` | DNS, TCP reset, 5xx | Exponential backoff, up to 3× |
| `transient.platform` | 429, "we're experiencing issues" banners | Backoff + tier the platform globally for the next 15 min |
| `transient.element` | Stale element, animation race | Re-locate and retry once |
| `permanent.selector_drift` | Expected selector missing despite multiple strategies | Capture DOM, mark adapter version drifted, alert; orchestrator parks remaining tasks for that adapter pending a hotfix |
| `permanent.policy` | Low-confidence answer, banned content, missing required field with no suitable answer | Skip with explicit reason, record AI decision |
| `permanent.account` | Login refused, account flagged, 2FA loop | Mark `platform_accounts.status = 'blocked'`, halt platform stage, notify user |
| `permanent.captcha` | Persistent challenge across attempts | Mode-A: pause; Mode-B: skip |
| `unknown` | Anything else | Capture artifact bundle, alert, mark `failed_platform_error` |

Selector drift is the most common; we mitigate it by:
- Layered selectors per element (`data-test-id` > stable role+name > stable text > nth-child fallback). The first that resolves wins.
- A nightly **adapter canary** workflow that runs each adapter's discovery (read-only, no apply) against the real site with a freshly-updated browser; failures alert before users hit them.
- Versioned adapters; the orchestrator records the adapter version in each `applications` row, so post-mortem rollups show which version broke.

## 15. Observability of the engine

Per-task structured fields on every log line: `userId`, `runId`, `stageId`, `applicationId`, `platformKey`, `adapterVersion`, `traceId`. Spans wrap each adapter step.

Metrics:
- `automation_step_duration_seconds{adapter, step, outcome}`
- `automation_apply_duration_seconds{adapter, outcome}`
- `automation_captcha_total{adapter, kind}`
- `automation_session_age_seconds{adapter}` (gauge)
- `automation_browser_pool_active`, `automation_browser_pool_idle`
- `automation_platform_rate_tokens{adapter}` (token bucket gauge)

Alerts:
- Selector drift incidents per adapter > threshold/hour.
- Apply success rate per adapter dropping > 25% week-over-week.
- CAPTCHA frequency per platform > 3× baseline.

## 16. Testing strategy (engine)

| Layer | Where | Mechanism |
| --- | --- | --- |
| Adapter unit | `packages/platform-adapters/<x>/test/unit.test.ts` | Pure functions (parsers, normalizers) against saved JSON |
| Adapter offline integration | `packages/platform-adapters/<x>/test/offline.test.ts` | Playwright loads saved HTML fixtures via `page.setContent` and `route` mocks; full apply happy path runs without internet |
| Adapter canary | nightly CI | Real site, read-only discovery; alerts on drift |
| Worker integration | `apps/automation-worker/test/` | Spins up a fake adapter and asserts retries, idempotency, semaphores |
| End-to-end | `infra/compose/e2e.compose.yaml` | Stack including a fixture site that mimics LinkedIn well enough for full apply flows |

## 17. Performance targets (engine)

| Operation | p95 target | Notes |
| --- | --- | --- |
| Context restore (warm) | 800 ms | Disk + S3 storage state |
| Context cold start | 3.0 s | Browser launch is the dominant cost; mitigated by browser reuse |
| Discovery for 200 listings | 90 s | With pipelined scoring |
| Apply on quick-apply platform | 25–45 s | Bounded by the platform |
| Apply on multi-step platform | 60–90 s | Same |
| Worker per-task overhead | 1.5 s | All non-platform time (logging, persistence, lock) |

Throughput target: a single worker pod (4 vCPU, 8 GB) supports ~20 concurrent `(user, platform)` pairs at safe rates; daily applications/user reach 80–160 with one platform connected and 200–400 with all connected. These are *capacity* numbers; actual runs are paced for safety, not for max throughput.

## 18. Security posture (engine layer)

Detailed in Phase 8; key intersections:

- Worker never holds long-lived credentials in memory. The vault-lease redemption token is single-use, 5-minute TTL, scoped to one `(user, platform)`.
- Storage state files in S3 are encrypted with the per-user data key; ciphertext is opaque to S3.
- Linux user namespaces isolate browsers per user where the deployment supports it; otherwise contexts are isolated by Playwright's process-level boundary plus a fresh `--user-data-dir` per user.
- Logs never include credential material; `valueRedacted` enforces redaction at the event boundary.
- Screenshots may capture sensitive form fields. We blur them server-side before persistence using a coordinate-aware redactor that consults the adapter's `sensitiveSelectors` list (e.g., password fields, OTP inputs); the unredacted version is never written to disk.

## 19. Tradeoffs accepted

- **Sequential per-platform-per-user.** Slower than parallelizing across platforms for one user, but parallel sessions for one identity is exactly the pattern that gets accounts flagged.
- **No CAPTCHA solving.** A categorical line. We accept a higher "skipped" rate in mode B in exchange for safety and TOS compliance.
- **Browser reuse over throwaway browsers.** Better trust signals, harder to debug an evil-state context. We mitigate with periodic context refresh (every 7 days) and per-task storage-state checkpointing.
- **No proxies by default.** Power users want them; default users don't need them; renting shared proxies is a rabbit hole of cost and reputation risk.
- **AI in the loop for ambiguous detections.** Adds cost and latency on the unhappy path; pays off in fewer false positives and fewer wrongful skips.

## 20. What this phase deliberately does not decide

- The exact CSS selectors per platform — they live in each adapter and evolve.
- The exact pacing distributions — tuned during M2/M5/M8 against real interaction telemetry.
- The remote-viewer service for human takeover in production — designed during M8.
- ATS-specific adapters (Workday, Greenhouse, Lever, Ashby) — M9 follow-up; the engine is built to host them.
