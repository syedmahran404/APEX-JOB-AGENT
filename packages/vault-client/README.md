# `@apex/vault-client`

HashiCorp Vault SDK wrapper. The only path through which the application touches Vault.

Reference: [Phase 8 §6](../../docs/architecture/08-security-architecture.md#6-credential-vault).

Capabilities:
- KEK wrap / unwrap via Vault Transit.
- Lease + redemption flow for worker credential access (single-use, 5-minute TTL, scoped to one `(user, platform, purpose)`).
- Vault PKI client for internal mTLS cert issuance.
- Database-secrets-engine adapter for rotating PG connection credentials weekly.

Two-reviewer rule (CODEOWNERS) on every change.
