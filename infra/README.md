# `infra/`

All deployment, observability, and operational artifacts. Phase reference: [Phase 9 — Deployment Architecture](../docs/architecture/09-deployment-architecture.md).

| Folder | Purpose |
| --- | --- |
| [`docker/`](./docker) | Multi-stage Dockerfiles per app, digest-pinned bases |
| [`compose/`](./compose) | Local dev, e2e, and self-hosted Compose stacks |
| [`k8s/`](./k8s) | Helm chart `apex-job-agent` and per-env values |
| [`terraform/`](./terraform) | Cloud infra (managed PG, Redis, S3, KMS, networking) |
| [`otel/`](./otel) | OTel collector config, Grafana dashboards, Alertmanager rules |
| [`scripts/`](./scripts) | One-off ops scripts (idempotent, documented, no inline secrets) |

Rule: nothing in `infra/` may contain plaintext secrets. Vault references and cloud-native secret stores resolve at deploy time.
