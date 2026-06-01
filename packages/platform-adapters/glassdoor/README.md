# `@apex/platform-adapters/glassdoor`

Glassdoor adapter. Frequently delegates to employer-specific ATS forms (Workday, Greenhouse, Lever). Out-of-scope ATS handoffs land as `applications.status = skipped_external_ats` until M9+ ATS adapters ship.

Milestone gate: [M8](../../../docs/architecture/10-implementation-roadmap.md#11-m8--remaining-adapters--remote-viewer).
