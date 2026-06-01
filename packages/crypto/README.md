# `@apex/crypto`

Envelope-encryption primitives and AAD construction helpers.

Reference: [Phase 8 §3](../../docs/architecture/08-security-architecture.md#3-cryptographic-architecture).

Contract:
- AES-256-GCM, 96-bit random nonce, ciphertext stored as `nonce || ct`.
- AAD constructed via `buildAad(domain, ...identityFields)`; binds ciphertext to row identity and version.
- HKDF derives per-purpose subkeys from the per-user DEK (`dek-credentials`, `dek-personal`, `dek-totp`, `dek-sessionstate`, `dek-qa`).
- DEKs are never serialized. In-process plaintext is wiped (zero-fill) on scope exit.
- Two-reviewer rule (CODEOWNERS) on every change to this package.
