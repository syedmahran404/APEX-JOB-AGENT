# CI/CD workflows

Reference: [Phase 9 §6](../../docs/architecture/09-deployment-architecture.md#6-cicd) and [Phase 2 §13](../../docs/architecture/02-folder-structure.md#13-cicd-layout-reference).

Planned workflows (added in M0):

| File | Trigger | Purpose |
| --- | --- | --- |
| `ci.yaml` | Every PR | install → typecheck → lint → unit tests → integration tests → OpenAPI drift → gitleaks → osv-scanner → build |
| `e2e.yaml` | Nightly + on `main` | Full Playwright suite (web + adapters against fixtures); AI eval harness on canonical suites |
| `prompt-eval.yaml` | On change to `packages/ai-core/prompts/**` | Run the eval harness; merge gated by 100% canonical / ≥95% regression |
| `adapter-canary.yaml` | Nightly | Each adapter's discovery against the real site (read-only); alert on selector drift |
| `release.yaml` | Tag `v*` | Verify signed digests, deploy to staging, smoke, manual approval, deploy to prod, smoke |
| `codeql.yaml` | Weekly + on PR | Security static analysis |
