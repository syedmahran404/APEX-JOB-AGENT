# `infra/compose`

Docker Compose stacks for non-Kubernetes environments.

Phase reference: [Phase 9 §13–§14](../../docs/architecture/09-deployment-architecture.md#13-self-hosted-profile).

Files:
- `dev.compose.yaml` — local dev: PG (with extensions), Redis, MinIO, Vault dev, MailHog, OTel collector. Boots in < 5 minutes.
- `e2e.compose.yaml` — hermetic stack used by CI for end-to-end Playwright tests, including a fixture site that mimics LinkedIn well enough to exercise apply flows.
- `selfhost.compose.yaml` — single-node deployment for power users; matches prod semantically except KEK lives in age-encrypted local Vault and object storage is MinIO.
