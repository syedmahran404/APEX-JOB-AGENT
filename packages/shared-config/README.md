# `@apex/shared-config`

Validated environment + feature-flag loader.

Reference: [Phase 4 §7](../../docs/architecture/04-backend-design.md#7-configuration-management).

Contract:
- Apps call `loadConfig(schema)` at boot.
- Returns a frozen object; failures crash-fast.
- `${vault:path/to/key}` references are resolved at boot via `@apex/vault-client` in production.
- No "default password if env not set" path is permitted; reviewers reject any such code.
