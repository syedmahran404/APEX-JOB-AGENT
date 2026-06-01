# `infra/scripts`

One-off operational scripts. Every script in this folder is:
- **Idempotent** — safe to re-run.
- **Documented** — top-of-file comment explaining purpose, prerequisites, and rollback.
- **Secret-free** — values resolved from Vault or environment, never inlined.

Examples (added as needed): `db-restore.sh`, `vault-rekey.sh`, `dek-rotate.sh`, `db-scrub.sh` (PII scrubbing for staging refresh from prod), `archive-ai-decisions.sh`.
