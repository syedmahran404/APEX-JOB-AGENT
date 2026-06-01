# `@apex/platform-adapters/linkedin`

LinkedIn adapter. First implementation; reference for the others.

Phase reference: [Phase 6](../../../docs/architecture/06-automation-engine.md), milestone gate: [M2](../../../docs/architecture/10-implementation-roadmap.md#5-m2--linkedin-end-to-end).

Capabilities targeted: Easy Apply quick-apply, multi-step apply, profile edit (gated), resume upload.

Per-adapter rules:
- All selectors layered; no fallback path = lint failure.
- `version.ts` semver bumped on every selector change.
- Offline tests against `fixtures/` must pass before the change merges.
- Nightly canary against the live site (read-only) is gating for "general availability."
