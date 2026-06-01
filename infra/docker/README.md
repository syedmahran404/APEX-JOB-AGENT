# `infra/docker`

Per-app Dockerfiles. Multi-stage; digest-pinned bases.

Phase reference: [Phase 9 §3](../../docs/architecture/09-deployment-architecture.md#3-image-strategy).

Files (added in M0):
- `api.Dockerfile` (Node 20 slim or distroless)
- `orchestrator.Dockerfile`
- `ai-service.Dockerfile`
- `automation-worker.Dockerfile` (Playwright base; the only image with Chromium)
- `analytics.Dockerfile`
- `web.Dockerfile` (multi-stage build → nginx)

Conventions: no `:latest` tags anywhere; `--provenance` and `--sbom` enabled in `docker buildx`; every image signed with `cosign` (Sigstore keyless via GitHub OIDC) before promotion.
