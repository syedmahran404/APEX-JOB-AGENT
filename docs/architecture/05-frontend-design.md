# Phase 5 — Frontend Design

## 1. Goals

The frontend is the user's command center for an autonomous agent operating on their behalf. It must:

- Make the *state of the world* obvious at a glance: what is running, what just submitted, what needs attention.
- Make trust *visible*: every AI decision, every permission scope, every credential, every status change, traceable from one click.
- Feel *fast*: optimistic where safe, real-time where it matters, never spinner-heavy.
- Feel *premium without theatre*: motion communicates state, not "hey look".
- Be *accessible*: WCAG 2.2 AA at minimum, with full keyboard navigation and reduced-motion respect.
- Be *resilient*: an offline tab should not lose user input; a flaky network should not break flow.

This is not a generic admin dashboard, and it is not a chatbot. It is the cockpit for a high-stakes background process the user has delegated to.

## 2. Stack and conventions

| Concern | Choice | Why |
| --- | --- | --- |
| Build | Vite 5 | Fast HMR, ESM-native, small config surface. Next.js was rejected because we don't need SSR and the streaming worker UX is a poor fit for the request model. |
| Framework | React 18 | Concurrent rendering, Suspense, transitions. |
| Routing | `react-router` v6 with file-based convention via `unplugin-react-router` | File routes mirror Next/Remix mental models without the SSR weight. |
| Language | TypeScript strict | Same rules as backend. |
| Styling | Tailwind CSS 3 + CSS variables for theme tokens | No styled-components runtime cost; tokens enable themes and contrast switching. |
| Component library | `packages/ui` (in-repo) | We do not adopt a third-party kit because the visual identity is bespoke. We use **Radix UI primitives** as headless behavior beneath our own components for a11y correctness. |
| Animation | Framer Motion 11 | Spring physics, layout animations, gestures. |
| 3D / hero scenes | React Three Fiber + drei + postprocessing | For the ambient command-center scene and a small set of premium moments. Used sparingly. |
| Server state | TanStack Query v5 | Caching, stale-while-revalidate, devtools. |
| Client UI state | Zustand (with `persist` and `subscribeWithSelector`) | Atomic, no boilerplate, plays well with React's transitions. |
| Forms | React Hook Form + Zod resolver | Native HTML semantics; Zod schemas reused from `packages/shared-types`. |
| Data viz | Visx primitives + d3-scale | Lower-level than Recharts; lets us match the design language exactly. |
| Realtime | Socket.IO client | Same convention as the server (`packages/realtime`). |
| Tables | TanStack Table v8 (headless) | Custom rendering inside our design system. |
| Date | Temporal API (polyfilled) | Avoids Moment/Day.js cruft; first-class time zones. |
| Icons | `packages/ui-icons` (custom set) + lucide as fallback | Visual identity. |
| i18n | `i18next` + ICU MessageFormat | Multi-locale ready; English ships M0, Hindi M9. |
| A11y testing | `@axe-core/react` + Playwright a11y assertions | Audited per route. |
| Tests | Vitest + React Testing Library; Playwright e2e | Same toolchain across the monorepo. |

## 3. Design system

### 3.1 Visual identity

- **Palette**: a deep ink base (`#0A0B0F`) layered with cool slate (`#13161D`) and a primary accent that shifts between **electric cyan** (`#22D3EE`) and **aurora violet** (`#8B5CF6`) for a calm-but-alive feel. Status colors are tuned for AAA contrast on the slate base: `#34D399` (success), `#F59E0B` (warn), `#F87171` (error), `#60A5FA` (info).
- **Glass surface**: a single canonical card style with `backdrop-blur`, 1px hairline border at `rgba(255,255,255,0.06)`, a subtle radial-gradient highlight at the top edge, and an `inset 0 1px 0 rgba(255,255,255,0.04)` to suggest a lit edge. We do not stack more than two glass surfaces; a third reads as noise.
- **Typography**: Display — `Geist`. UI — `Inter`. Mono — `JetBrains Mono`. Numeric data uses `tabular-nums` for stable column alignment.
- **Radii**: 8 / 12 / 16 / 24 px. 24 reserved for hero panels. 8 for chips and inline controls.
- **Shadow**: minimal; a single `shadow-[0_1px_0_rgba(255,255,255,0.06),0_24px_48px_-24px_rgba(0,0,0,0.6)]` token used for elevated surfaces.
- **Motion language**: spring `{ stiffness: 220, damping: 28 }` for layout; tween `{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }` for entrances. Reduced-motion users get instant transitions and crossfades only.

### 3.2 Tokens

Tokens live as CSS variables in `apps/web/src/styles/tokens.css` and are mirrored in Tailwind via `theme.extend`. Components read tokens, never raw colors. Themes (dark default, light future) swap a single `[data-theme]` attribute.

```
--color-bg-base, --color-bg-raised, --color-bg-glass
--color-text-primary, --color-text-secondary, --color-text-muted
--color-accent, --color-accent-soft, --color-accent-strong
--color-success, --color-warn, --color-error, --color-info
--radius-sm, --radius-md, --radius-lg, --radius-xl
--space-1 ... --space-12
--shadow-elev-1, --shadow-elev-2
--ring-focus
```

### 3.3 Component inventory (`packages/ui`)

Primitives (Radix-backed where applicable): `Button`, `IconButton`, `Input`, `Textarea`, `Select`, `Combobox`, `Switch`, `Checkbox`, `Radio`, `Slider`, `Dialog`, `Drawer`, `Sheet`, `Popover`, `Tooltip`, `Toast`, `Tabs`, `Accordion`, `DropdownMenu`, `ContextMenu`, `Form`, `Field`, `Label`, `HelpText`, `Kbd`, `Skeleton`, `Spinner`, `EmptyState`.

Composites (in `packages/ui` because reused across pages): `Glass`, `Card`, `MetricTile`, `StatusPill`, `FreshnessBadge`, `ProgressRing`, `ScoreMeter`, `TimelineItem`, `ChartFrame`, `DataTable`, `Diff`, `CodeBlock`, `Avatar`, `IdentityChip`, `PlatformIcon`.

App-local composites (in `apps/web/src/components`): page-specific composites that haven't proven reuse yet (`RunControlBar`, `ActivityFeed`, `ApplicationCard`, etc.). They graduate into `packages/ui` only after second use.

## 4. Information architecture

The app's mental model is **the run** at the center, with profile, knowledge base, resumes, and analytics orbiting around it. The navigation reflects that.

```
┌─ Top bar: identity, run-status pill, command palette (Cmd-K), notifications, help ─┐
│                                                                                    │
│  Side nav (collapsible):                                                           │
│   • Command Center                                                                 │
│   • Job Stream                                                                     │
│   • Applications                                                                   │
│   • Resumes                                                                        │
│   • Profile                                                                        │
│   • Knowledge (Q&A memory + frequent answers)                                      │
│   • Analytics                                                                      │
│   • Optimization (suggestions inbox)                                               │
│   • Activity (audit timeline)                                                      │
│   • Settings (security, platforms, permissions, billing)                           │
│                                                                                    │
└────────────────────────────────────────────────────────────────────────────────────┘
```

A persistent **Run Status Pill** in the top bar is always visible while authenticated: it shows the active run's stage, platform, and rate; clicking expands a mini-panel with pause/resume/stop. This is the single source of "what is happening right now" no matter where the user is.

## 5. Screens (specifications)

### 5.1 Onboarding wizard (5 steps, skip-aware)

1. **Welcome / consent**: a single screen explaining what the agent will do on the user's behalf. Two checkboxes: "I authorize automated form submission within my own platform sessions" and "I understand AI-generated answers are reviewable in the Knowledge tab." Both required.
2. **Resume upload**: drag-and-drop. Parse status streamed live (uploading → parsing → structuring → done). The parsed structure is shown in an editable panel; the user confirms or corrects. This becomes the first `resumes/resume_versions/resume_files` triple.
3. **Profile facts**: one panel per group (personal info, education, experience, projects, skills, links). Each pre-filled from parse; each editable. Sensitive fields (DoB, phone, address) are hidden behind a "Reveal" gesture and a step-up MFA challenge if not recently authenticated.
4. **Preferences**: salary range, locations, remote/hybrid/onsite, employment types, notice period, willing-to-relocate, threshold score (default 70). Each control has a small "what this means" tooltip.
5. **Connect platforms**: a grid of 8 platforms. Each card has a "Connect" button that opens a modal asking for the platform credentials, with explicit text: "We seal these in your vault and use them only when the worker logs into your session." Successful connect changes the card state to "connected". Skipping is supported.

The wizard supports back/forward, persists at every step, and can be exited and resumed.

### 5.2 Command Center (default landing)

The hero of the app. Layout:

- **Hero strip** (R3F-driven, calm). A subtle particle field whose density reflects active runs and whose hue shifts toward the active platform's color. Reduced-motion replaces this with a static gradient.
- **Run controls**:
  - "Start a Run" CTA — opens a dialog (mode, platforms, target per platform, threshold, autonomous toggle).
  - If a run is active, a `RunControlBar` shows pause/resume/stop, current stage, applications submitted vs target, and a thin progress meter.
- **Live activity feed**: a vertical timeline of events (run started, stage changed, application submitted, AI question answered, etc.). New items animate in with a spring; old items fade. Each item is clickable for detail.
- **Today's metrics**: 4 `MetricTile`s — applications today, pending, response rate (24h), AI cost (today). Each opens its analytics drilldown on click.
- **Eligible jobs preview**: top 5 jobs the AI scored highly that have not yet been queued. Clicking opens the Job Stream with that job pre-selected.
- **Suggestions snippet**: top 3 profile/resume suggestions awaiting approval, with a "Review all" link.

Real-time: subscribes to `events:user:{user_id}` and updates the feed and tiles immediately. No polling.

### 5.3 Job Stream

A dense, sortable list of discovered jobs (last 7 days), with a side detail panel.

Columns: title, company, platform (icon + name), location, posted (relative + absolute on hover), freshness tier (`FreshnessBadge`), AI score (`ScoreMeter`), action ("Apply now", "Skip", "Save"), and a per-row reasoning popover that shows the AI's score reasoning and the matching skills.

The list is virtualized (TanStack Virtual). Filters (platform, freshness, score range, location, remote kind) are URL-driven so links are shareable. Sorting respects the freshness rule by default: t5h jobs always sort above older ones regardless of secondary sort.

### 5.4 Applications

Two views: **pipeline** (kanban by status) and **table** (TanStack Table).

In pipeline view, columns are `Queued`, `Submitting`, `Submitted`, `Viewed`, `Shortlisted`, `Interview`, `Offer`, with `Rejected/Skipped/Failed` collapsed by default into a "Closed" group. Cards show a compact summary; dragging an *outcome* card (e.g., `Submitted` → `Shortlisted`) issues a status override with a confirmation (because we are claiming an outcome the platform may not have signaled).

The detail drawer shows a complete timeline (`application_events`), the questions asked & answers given (with their source: `frequent_answer`, `qa_memory`, `ai_generated`, `user_intervention`), the AI score and reasoning, and links to the resume version used + screenshots. Every step is downloadable as a single audit PDF for record-keeping.

### 5.5 Resumes

- **List**: thumbnails of resumes, default badge, version count, last used.
- **Studio**: a versioned editor. Left pane is a structural editor (sections, bullets, drag-to-reorder); right pane is a live PDF preview. The header has a version selector and a `Diff` view that shows changes between any two versions. AI-tailored versions are clearly marked and require explicit approval before they become the current version.
- **Permissions strip**: switches for "Allow AI to edit resumes globally" and per-platform overrides. Off by default.

### 5.6 Profile

A long form, broken into collapsible groups: Identity, Education, Experience, Projects, Skills, Links, Personal info (sensitive — collapsed by default and behind step-up MFA). Each group has its own save state; nothing saves until the user explicitly saves. The "AI suggestions" rail on the right shows pending suggestions that target this section.

### 5.7 Knowledge

Two tabs:
- **Frequent Answers** (`frequent_answers`). A table of canonical answers. Each row has an `is_locked` switch. Locked answers are never rewritten by AI.
- **Q&A Memory** (`qa_memory`). The agent's accumulated answer corpus. Filter by platform, recency, source. Clicking an answer shows where it has been used (`application_questions`). Editing an answer marks it `user_corrected` and bumps the embedding.

### 5.8 Analytics

Tabs: **Overview**, **Funnel**, **Platforms**, **Resumes**, **Skills**, **Operations**.

- **Overview**: time-series of applications submitted (daily/weekly/monthly toggle), with overlays for response rate and conversion rate.
- **Funnel**: discovered → eligible → applied → viewed → shortlisted → interview → offer. Each step labeled with absolute counts and conversion %.
- **Platforms**: one row per platform, with applications, success rate, average time-per-application, and CAPTCHA frequency.
- **Resumes**: per resume version, applications used in, response rate, top matched skills.
- **Skills**: skills mentioned in highest-converting jobs vs the user's profile; gaps highlighted.
- **Operations**: AI cost over time, error rates, queue depths. This tab is owner-only.

All charts share a `ChartFrame` (consistent legend, tooltip, brushing). Real-time tiles are stamped with a tiny "live" indicator.

### 5.9 Optimization (Suggestions inbox)

A list of pending suggestions grouped by area (headline, summary, skills, resume bullet, etc.). Each card shows current vs proposed in a `Diff` and a one-line expected benefit. Two buttons: Approve / Reject. Approving applies the change atomically and adds a row to the activity log. Rejecting captures a one-line reason that is fed back as negative training signal.

### 5.10 Activity (audit timeline)

A reverse-chronological feed of every consequential event (login, MFA change, permission grant, profile edit, run start/stop, application submit, AI cost spike). Searchable by kind and date. The hash chain integrity check is shown at the top: a green "verified" pill when consistent, a red "tampered" pill if not (in which case the user is prompted to contact support; this should never appear in normal operation).

### 5.11 Settings

Sections: **Account** (email, display name, password), **Security** (sessions, MFA factors, recovery codes, data export, delete account), **Platforms** (per-platform connect/disconnect, permissions, autonomous mode), **Notifications** (channel preferences, frequency, quiet hours), **Billing** (when M9 enables it). Each section has an audit footer linking to its filtered Activity view.

## 6. Real-time UX

The frontend treats real-time as a **freshness booster on top of authoritative reads**, not a primary source. Every screen first reads via TanStack Query; updates from Socket.IO invalidate or patch query caches.

Implementation:

- A single Socket.IO connection per tab, established after auth. Reconnect with exponential backoff up to 30 s. On reconnect, a `since` cursor lets us replay missed events from the API (`GET /events?since=...`), so a brief network drop never loses state.
- Channels:
  - `events:user:{user_id}` — run lifecycle, application status changes, suggestions added, security events.
  - `events:run:{run_id}` — joined transiently while the user is on a run-detail page.
- A small `useRealtime(topic, handler)` hook in `apps/web/src/hooks/` ensures consistent join/leave behavior.
- The `RunStatusPill` subscribes globally; everything else subscribes locally to its topic.

Optimistic updates: only for low-stakes actions (mark notification read, dismiss suggestion). Mutations on permissions, runs, or credentials are pessimistic with explicit "applying…" states.

## 7. Forms

Forms are the highest-friction part of any product. Conventions:

- One Zod schema per form, imported from `packages/shared-types/api`. The same schema validates client and server.
- Errors render at the field level (`HelpText` with role="alert"), and a top-of-form summary lists errors with anchor links for keyboard users.
- Long forms use `react-hook-form`'s `useFieldArray` with smooth Framer-Motion enter/exit on add/remove.
- Sensitive forms (personal-info, credentials, MFA) clear in-memory state on unmount and never write to `localStorage` autosave.
- Autosave on long-form profile: debounce 1 s, only on field blur, and only after server-side dirty-state confirms.
- Files: drag-and-drop with progress, retries, and resumable uploads via tus.io for files > 10 MB (resumes are typically small, but cover-letter drafts and attachments may not be).

## 8. Accessibility

- WCAG 2.2 AA at minimum, with explicit AA color contrast on every token.
- Keyboard: every action reachable; visible focus rings via `--ring-focus`; logical tab order; skip-to-content.
- Screen readers: live regions for the activity feed and run-status pill so events are announced (`aria-live="polite"`); status changes ("Run paused", "Application submitted to LinkedIn") are formatted for clarity.
- Motion: `prefers-reduced-motion: reduce` disables R3F particles and replaces motion variants with crossfades.
- Color: never the sole channel of meaning. Status pills carry text and an icon as well as color.
- Forms: explicit labels, `aria-describedby` for help/error, `aria-invalid` on error.
- A11y CI: `@axe-core/playwright` runs on every key page; violations of WCAG 2.2 AA fail CI.

## 9. Performance budgets

| Metric | Target | Mechanism |
| --- | --- | --- |
| Initial JS (gzipped) | ≤ 180 KB main, ≤ 60 KB per route chunk | Route-level code splitting; R3F + drei lazy-loaded only on Command Center |
| TTI on Command Center | ≤ 2.0 s on 4G mid-tier device | Critical CSS inlined, fonts preloaded, server pushed cache headers |
| INP (interaction) | ≤ 100 ms p95 | Concurrent rendering, transitions, virtualization |
| LCP | ≤ 1.8 s | Static hero text + low-cost background; no large images above the fold |
| CLS | ≤ 0.05 | Reserved heights for skeletons; no late-loaded fonts |
| WebSocket reconnect | ≤ 3 s p95 | Exponential backoff with cap |

We hard-budget these in CI: a Lighthouse CI run on every PR fails if budgets regress > 10%.

## 10. State management map

| State category | Storage | Lifetime |
| --- | --- | --- |
| Server data (auth, profile, runs, applications, analytics) | TanStack Query cache | Per session; queryKey-driven invalidation |
| Real-time deltas | Patches into TanStack Query caches via `setQueryData` | Per session |
| Auth identity & session metadata | Zustand store (non-persisted) | Tab lifetime |
| UI preferences (theme, density, sidebar collapsed, pinned filters) | Zustand `persist` (localStorage) | Across sessions |
| Form drafts (long profile only, opt-in) | IndexedDB via Dexie | Cleared on submit or 24h |
| Command palette state | Zustand (non-persisted) | Tab lifetime |
| Sensitive state (decrypted previews of credentials, MFA enrollment in progress) | In-memory only; cleared on unmount | Component lifetime |

The rule: anything that contains user PII or credentials is in-memory only. Anything else may be cached for UX.

## 11. Testing strategy (frontend)

| Layer | Tool | Scope |
| --- | --- | --- |
| Component unit | Vitest + RTL | Isolated component behavior, including reduced-motion variants |
| Visual regression | Storybook + Chromatic (or Playwright snapshots if Chromatic is out of budget) | Per component, per state |
| Hook unit | Vitest + RTL `renderHook` | `useRealtime`, `useAuth`, `useRunStatus` |
| Integration (page-level) | Vitest + RTL + MSW | Fake API responses; assert flows |
| E2E | Playwright | Full app in `infra/compose/e2e.compose.yaml` |
| A11y | `@axe-core/playwright` | Every key route |
| Performance | Lighthouse CI | Per PR |
| Contract | Generated SDK + recorded API responses | Per PR |

## 12. Three.js / R3F policy

Used in three places, and only three:

1. **Command Center hero** — ambient particle field bound to live activity.
2. **Run "running" indicator** — a tiny in-line shader badge that replaces the spinner when a run is active.
3. **Onboarding success moment** — a one-shot animation when the user finishes the wizard.

Everything else is 2D. R3F bundle is loaded behind `React.lazy`; the page renders fully without it. Reduced-motion replaces R3F with static SVG.

## 13. Internationalization & locale

- All copy in `apps/web/src/i18n/en.json` (default). Keys are namespaced by route.
- Numbers and dates use `Intl.NumberFormat` and Temporal's locale-aware formatters.
- RTL-readiness: layouts use `start/end` logical properties; the design language survives RTL.
- Initial release ships English. Hindi is the next locale, scheduled with M9.

## 14. Error handling and empty states

- Every page has an `ErrorBoundary` that renders a recoverable `ErrorState` with a retry. `ErrorState` shows a stable `code`, the `traceId` (one-click copy), and the timestamp. The boundary reports to Sentry and attaches the same `traceId` for correlation.
- Empty states are designed, not stubbed: each one tells the user what to do next and links to it (e.g., the empty Applications page links to "Connect a platform" or "Start a run").
- Loading states never use spinners alone past 200 ms; they use skeletons that match the shape of the data, so layout doesn't jump.

## 15. Tradeoffs accepted

- **Vite + react-router over Next.js.** We give up SSR and image optimization; we gain a lighter, more transparent build, and we don't need SSR for an authenticated cockpit.
- **Custom design system over a kit (shadcn, Mantine, MUI).** More upfront work; we get a unique identity and full control over a11y, motion, and density. Radix beneath gives us correctness without dictating look.
- **TanStack Query as the *only* server-state cache.** No Redux, no SWR. Single mental model; the Zustand store is intentionally tiny.
- **R3F only in three places.** Disciplined use; we resist "let's make every section 3D" for both performance and taste reasons.
- **Optimistic updates only on low-stakes actions.** A worse UX in 1% of cases (a mutation feels slow) bought a much better worst-case (we never claim a state we can't deliver).

## 16. What this phase deliberately does not decide

- Specific Storybook stories — they ship with components in M0/M2.
- Specific copy and microcopy — content review pass in M4.
- Final pixel layouts — design files live in `docs/design/` (added when the design contractor or in-house designer joins).
- Mobile native apps — out of scope; the PWA shell ships M9 if telemetry justifies it.
