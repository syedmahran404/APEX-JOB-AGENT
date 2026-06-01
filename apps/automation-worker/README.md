# `apps/automation-worker` — Playwright workers

Drains BullMQ tasks and operates the platform sites within the user's authenticated session. Holds no long-lived credentials.

Phase reference: [Phase 6 — Automation Engine](../../docs/architecture/06-automation-engine.md).

Layout:
- `pool/` — Browser pool and BrowserContext lifecycle (one warm context per `(user, platform)` with TTL = 10 min).
- `leases/` — Vault lease redemption; plaintext credentials live in memory for seconds, never on disk.
- `tasks/` — `discovery.task.ts`, `apply.task.ts`, `login.task.ts`, `health.task.ts`.
- `reporting/` — Outbox writer; screenshot uploader (with sensitiveSelectors blur applied server-side before upload).
- `safety/` — CAPTCHA detector, rate-limit watcher, kill-switch.

Hard rules:
- One active page per `(user, platform)` (Redis semaphore enforces).
- No two tasks for the same user simultaneously even across platforms.
- No CAPTCHA solving; no third-party proxies; no parallel sessions per identity.
- Egress restricted to allowlisted platform domains, Vault, AI service, S3, Redis.
