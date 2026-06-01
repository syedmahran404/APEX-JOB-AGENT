# Changesets

Internal package versioning for `packages/*`. Apps in `apps/*` are versioned by release tag, not per-package.

Workflow:

1. After making a change to one or more `packages/*`, run `pnpm changeset` and describe the change.
2. The changeset is committed alongside the code change.
3. Release CI consumes accumulated changesets to bump versions and update `CHANGELOG.md`.

Reference: [Phase 9 — Release management](../docs/architecture/09-deployment-architecture.md#15-release-management).
