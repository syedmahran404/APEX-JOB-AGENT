# `@apex/automation-core`

Reusable infrastructure for the automation engine. Per-platform behavior lives in `packages/platform-adapters/<x>`.

Reference: [Phase 6 — Automation Engine](../../docs/architecture/06-automation-engine.md).

Contents:
- `BrowserPool` — manages `Browser` (per adapter family) and `BrowserContext` (per `(user, platform)`) with TTL eviction.
- `BasePlatformAdapter` — defaults for retries, screenshots, event emission, layered selectors.
- `PlatformAdapter` interface (`ensureSession`, `search`, `parseListing`, `parseJob`, `canApply`, `apply`, optional `applyProfileChange`, `uploadResume`).
- Anti-detection layers (identity profile generator, behavior simulator).
- `ApplyEvent` taxonomy and emission helpers.
- CAPTCHA / OTP / verification detector.
- Pacing profiles (`STRICT_DEFAULT`, `BALANCED`, `FAST`).
