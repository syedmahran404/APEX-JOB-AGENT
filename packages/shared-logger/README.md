# `@apex/shared-logger`

Pino-based structured logger with OpenTelemetry trace correlation and a project-wide PII redaction allowlist.

Reference: [Phase 4 §8](../../docs/architecture/04-backend-design.md#8-logging-tracing-metrics) and [Phase 8 §11](../../docs/architecture/08-security-architecture.md#11-logging-redaction-and-observability).

Defaults:
- Output: JSON to stdout.
- Mandatory fields: `traceId`, `spanId`, `service`, `userId?`, `runId?`, `applicationId?`.
- Redacted keys (deny-list): `password`, `secret`, `token`, `cipher*`, `dek`, `kek`, `vault_*`, `phone*`, `dob`, `address*`, `ssn`, `aadhaar`. Object keys ending in `_enc` are stripped entirely from output.
