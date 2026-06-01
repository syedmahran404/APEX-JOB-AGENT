# Phase 8 — Security Architecture

## 1. Goals

Security here is not a checklist; it is the precondition for the product. The agent holds a user's professional identity and the credentials to eight platforms. A breach is not "data lost" — it is "the user's career, automated by a stranger." The architecture is therefore designed so that:

- **The blast radius of any compromise is one user.** A compromised host, a leaked DB dump, a poisoned worker — none of them produce a master key, a cross-user index, or a usable credential set across the population.
- **Plaintext sensitive data exists only where it is actively used.** It is never at rest in the database, never in logs, never in the analytics warehouse, never in backups except when sealed.
- **Every consequential action is observable.** Reads of secrets, profile mutations, permission grants, and credential redemptions all leave an immutable trace.
- **The system fails closed.** When a security control is unavailable (KMS, vault, MFA), we refuse to act, not improvise.

Phases 1–7 already encode many security decisions. This phase consolidates them, names the threat model, fills the gaps (crypto details, key rotation, supply chain, incident response), and answers "what stops X."

## 2. Threat model

### 2.1 Assets, by sensitivity tier

- **Tier 0 — catastrophic if leaked**: platform credentials, MFA secrets, password hashes' rotation oracles, the master KMS key, per-user DEKs in plaintext, signed-cookie HMAC keys.
- **Tier 1 — severe**: personal identifying information (DoB, phone, address), session storage states (cookies for the user's platform sessions), Q&A memory (often contains salary, immigration, health), audit log integrity.
- **Tier 2 — sensitive**: full profile data, resumes, cover letters, application history, AI decision history.
- **Tier 3 — operational**: internal service credentials, signing keys for short-lived JWTs, logs without PII, metrics.

### 2.2 Adversaries

- **External attacker** with internet access, no prior credentials.
- **Compromised dependency** (typosquat, malicious patch in `node_modules` or a Docker base image).
- **Curious operator** with read access to logs/metrics and partial DB access.
- **Compromised single host** — one node in the cluster fully owned.
- **Stolen backup** — a DB dump leaks.
- **Lost client device** — the user's laptop, phone, or password.
- **Malicious user** — someone who creates an account intending to abuse the platform (test the multi-tenant boundary; once M9 lands).
- **Hostile platform site** — a job site serves a payload designed to attack our worker (prompt injection through job text, malicious file downloads, exploit JS).
- **Insider** — the system designer included.

### 2.3 STRIDE-driven scenarios

| Threat | Surface | Mitigation phase |
| --- | --- | --- |
| Spoofing | Forged session cookies, session fixation | §4 (auth), §6 (sessions) |
| Tampering | DB write of a fake `applications` row, audit log alteration | §3 (envelope), §10 (audit chain), §15 (least-privileged DB roles) |
| Repudiation | "I never approved that resume change" | §10 (audit), §4 (step-up MFA) |
| Information disclosure | DB leak, log leak, screenshot leak, AI prompt leak | §3 (envelope at column level), §11 (log redaction), §12 (artifact redaction) |
| DoS | Auth flood, run flood, AI cost burn | §13 (rate limits), §7 (cost governor in Phase 7) |
| Elevation of privilege | Worker escalates to admin, AI service mutates DB | §14 (mTLS + JWT), §15 (DB roles), §17 (network policies) |

## 3. Cryptographic architecture

We use **envelope encryption with per-user data keys**, plus targeted column-level encryption for fields that must remain unreadable even to the application service.

### 3.1 Key hierarchy

```
Root of trust:   HashiCorp Vault Transit (prod) / age-encrypted local Vault (dev)
                 Master key never leaves Vault. All wrap/unwrap via Transit API.

KEKs (Key-Encryption-Keys, in Vault):
  - kek/users/dek      → wraps per-user Data Encryption Keys (DEKs)
  - kek/sessions       → wraps session-storage-state ciphertexts
  - kek/backups        → wraps DB logical backups before upload to cold storage
  - kek/jwt/internal   → signs short-lived internal service-to-service JWTs (rotates daily)

Per-user DEK (32-byte random AES-256 key):
  - Generated at user creation by the API gateway calling Vault.
  - Stored in the DB as ciphertext: users.data_key_wrapped (wrapped by kek/users/dek).
  - Unwrapped on demand by the API at session establish; held in process memory only.

Cipher streams from a DEK (HKDF-derived subkeys per purpose):
  - dek-personal      → encrypts personal_info.*_enc
  - dek-credentials   → encrypts platform_credentials.cipher
  - dek-totp          → encrypts totp_secrets.secret_wrapped
  - dek-sessionstate  → encrypts platform_sessions.storage_uri payload
  - dek-qa            → encrypts qa_memory.answer (when category is sensitive)
```

The application **never sees a KEK**. It sees only its memory copy of the user's DEK during the user's session window, and ciphertext blobs everywhere else.

### 3.2 AEAD construction

Every column or object encryption uses **AES-256-GCM** with a per-message random 96-bit nonce. The nonce is concatenated with ciphertext (`nonce || ct`) and stored as `BYTEA`. The Authenticated-Data (AAD) is a domain-specific tuple, e.g., for `platform_credentials.cipher`:

```
AAD = "platform_credentials" || account_id || rotation_version
```

Why AAD: it binds the ciphertext to its row identity and version. A copied blob written to a different row will fail to decrypt. AAD is reconstructed on read; it is not stored.

### 3.3 Per-user DEK lifecycle

- **Creation**: at sign-up, after WebAuthn enrollment is verified.
- **Use**: API holds the DEK in a `Map<sessionId, DEK>` in memory; cleared on logout, expiry, or process restart. The DEK is not pickled, not serialized, not ever written outside of memory.
- **Forwarding**: workers do not get the DEK. They get **scoped credential leases** (Phase 1 §11). The vault performs the unwrap on the worker's behalf for one specific operation.
- **Rotation**: routine rotation every 365 days; on suspicion, immediate rotation. New DEK generated, all DEK-encrypted blobs re-encrypted in a background job, old DEK destroyed in Vault.
- **User account deletion**: the user's row in `users` is soft-deleted; after the 30-day grace, the DEK is destroyed in Vault. All ciphertext blobs become permanently unreadable. This is the strongest form of "right to be forgotten" we can implement.

### 3.4 Vault deployment posture

- Vault HA cluster with Raft storage in prod; auto-unseal via cloud KMS (AWS KMS or GCP KMS as the unseal mechanism, never as the key store).
- Audit logs from Vault streamed to a separate log store with restricted ACL.
- Rotation policies for unseal keys; quarterly drills.
- Dev profile uses a single-node Vault with a file backend, age-encrypted to a developer-specific key. The dev profile is not capable of reading prod ciphertext.

## 4. Authentication

### 4.1 Primary factor — passwordless preferred

The **default sign-up path is WebAuthn (platform passkey or roaming authenticator)**. Email + password is supported as a fallback because not every user has a passkey-capable device, but it is presented second in the UI, and accounts created with a password are immediately invited to enroll WebAuthn.

Password (when present):
- Hashed with **Argon2id**, parameters `m=128 MiB, t=3, p=4` (calibrated yearly).
- Length minimum 12, with breached-password check via local `haveibeenpwned` k-anon API (offline corpus in self-host).
- Lockout: exponential backoff per `users.failed_login_count`, hard lock at 10 with email-based unlock.

WebAuthn:
- RP ID is the production hostname; we never accept assertions from another origin.
- `userVerification: 'required'` for high-risk flows (sign-in, step-up).

### 4.2 Second factor

- WebAuthn alone counts as MFA when the authenticator did `userVerification`.
- TOTP (RFC 6238, 30 s window, 6 digits) as alternative; the secret is stored encrypted with the user DEK.
- Recovery codes: 10 single-use, hashed with Argon2id.
- Phone-based SMS is **not supported.** SIM swap is a real, common attack on this product.

### 4.3 Sessions

- Session id: 32 bytes from `crypto.randomBytes`, base64url. Cookie `__Host-apex_sid; Secure; HttpOnly; SameSite=Lax; Path=/`.
- DB stores `SHA-256(session_id)` (defense if `user_sessions` rows leak).
- Idle timeout 8 h; absolute timeout 14 days; sliding refresh on activity.
- A session record carries `data_key_handle` — a process-local handle, not stored, allowing the API to retrieve the user's unwrapped DEK from memory.
- Server-initiated revocation possible at `POST /auth/sessions/revoke` and on global events (password change, WebAuthn key rotation, suspected compromise). Revocation is global across all replicas via Redis Pub/Sub.
- CSRF: double-submit token pattern. The token is `HMAC(session_id || path_prefix)` with a key rotated daily. Required on non-GET methods. Same-origin checks complement.

### 4.4 Step-up authentication

Operations that require fresh MFA (within the last 10 minutes), regardless of prior session age:
- Reading `personal_info`.
- Adding/rotating platform credentials.
- Granting any permission (`profile.edit`, `resume.edit.*`).
- Approving a resume version produced by AI tailoring.
- Disabling MFA, deleting the account.

Step-up state is held in the session record (`mfa_proof_at`) and checked by a guard. UI surfaces this with a brief prompt (no full sign-out).

## 5. Authorization

Two layers, evaluated in order, default deny.

1. **RBAC** — `owner`, `viewer`, `automation_bot`. The `automation_bot` role is internal; it is the identity workers assume when calling the AI service or the credential vault. It cannot read user-facing resources directly.
2. **Permission scopes** — fine-grained capabilities encoded in `user_permissions` with a JSON `scope`:
   - `profile.edit` — global profile edits.
   - `resume.edit.global`, `resume.edit.<platform>` — resume edits.
   - `platform.connect`, `platform.disconnect`.
   - `run.start`, `run.stop`.
   - `ai.tailor.global`, `ai.tailor.<platform>`.
   - `optimization.suggest` — receives suggestions (default on); separate from approving them.

Effect:
- `optimization.review` runs read-only; no mutation possible.
- A user with `resume.edit.linkedin = true` and `resume.edit.naukri = false` cannot have AI rewrite their LinkedIn-bound resume even by mistake — the `resumes` row writes are gated.

A guard decorator `@RequirePermission('resume.edit', { scope: { platform: 'linkedin' }})` lives in the API; failures return `403 forbidden` with `code: 'permission_required'`.

## 6. Credential vault

The vault is a separate, hardened service (HashiCorp Vault, in our case with the Database secrets engine and the Transit secrets engine). It does **not** store user-facing data; it stores the cryptographic material that protects user-facing data.

### 6.1 Storing platform credentials

When the user adds a credential through the UI:
1. The browser sends the credential over TLS to the API.
2. The API holds the credential in memory only long enough to:
   - Generate a fresh nonce.
   - Derive the `dek-credentials` subkey via HKDF from the user DEK.
   - AES-256-GCM-encrypt the credential with AAD `("platform_credentials", account_id, rotation_version)`.
   - Persist the ciphertext to `platform_credentials.cipher`, the AAD components, and a Vault key alias.
   - Emit `audit_log` entry `credentials.create` with metadata only (never the credential).
3. The plaintext is wiped (zeroed) before the function returns.

### 6.2 Lease + redemption flow (worker side)

Workers never receive long-lived credentials. The flow:

1. The orchestrator decides "this worker needs to sign in to LinkedIn for `user_id=U`."
2. The orchestrator calls Vault via the API gateway: `POST /vault/lease { user_id: U, platform: 'linkedin', purpose: 'login', ttl: 5m }`.
3. The vault returns `{ lease_id, redemption_token, expires_at }`. The token is single-use, 5-minute TTL, scoped to one `(user, platform, purpose)` tuple.
4. The orchestrator hands `redemption_token` to the worker via the BullMQ payload.
5. The worker opens its Playwright page to the login screen and *only then* calls `POST /vault/redeem { redemption_token }` over mTLS.
6. The vault verifies the token, unwraps the DEK on the user's behalf via Vault Transit, decrypts the credential, returns the plaintext bundle in the response body.
7. The worker types the credential into the page using its keystroke machinery; the plaintext lives only in the worker's memory and is wiped immediately after the form is submitted.

Failure to redeem within 5 minutes invalidates the token; a redeemed token is also invalidated. Every redemption writes an `audit_log` row.

### 6.3 Why this design

- The DB alone is not enough to log in as the user; the attacker needs the Vault as well.
- The worker is the highest-risk component (Playwright, third-party domains). It holds plaintext for seconds, not days.
- The orchestrator never sees plaintext; it only brokers the lease. A compromised orchestrator cannot exfiltrate credentials by reading Vault — the redemption token is keyed to the worker's mTLS identity and one-time use.

## 7. Browser worker isolation

The most exposed surface in the system. Hardening:

- **Per-user OS user namespace** (Linux `userns`) when the host kernel supports it, or fallback to **per-user `--user-data-dir`** plus a per-user UID. Either way, no shared on-disk state between users.
- **Linux capabilities dropped**: workers run with `NoNewPrivileges`, `seccomp` profile that allows only what Chromium needs, and a read-only root filesystem with tmpfs scratch.
- **Egress firewall**: workers can reach the configured platform domains and `vault.internal`, `ai-service.internal`, `s3.internal`, `redis.internal`. They cannot reach arbitrary internet hosts; an attempt is logged.
- **Outbound HTTP through a logging proxy (envoy)** that records destinations and sizes for audit. The proxy denies non-allowlisted domains.
- **No Docker-in-Docker, no runtime tooling**. The container is not "general purpose."
- **One Chromium per browser pool slot**, refreshed every 24 h to flush any malicious page-resident state that escaped.
- **File downloads**: routed to a tmpfs scratch directory, scanned by ClamAV (offline signature update via a sidecar), then either uploaded to S3 or discarded. We never persist a downloaded file unless an adapter explicitly consumed it.
- **Page-level CSP injection**: where adapters allow, we inject a meta CSP for our own injected scripts, scoped to `'self'`. (We rarely inject; this is a defense in depth for fingerprint helpers.)

## 8. Network and transport

- **Mutual TLS** between all internal services, certificates issued by an internal CA managed by Vault PKI. Certs rotate every 30 days; service mesh (Linkerd) automates the rotation.
- **TLS 1.3** for external traffic; TLS 1.2 minimum, no SSL.
- **HSTS** on the public domain with `max-age=63072000; includeSubDomains; preload`.
- **Strict CSP** on the web app:
  ```
  default-src 'self';
  script-src 'self' 'wasm-unsafe-eval';
  connect-src 'self' wss://api.<host>;
  img-src 'self' data: blob:;
  style-src 'self' 'unsafe-inline';   # Tailwind requires inline styles only for runtime tokens; reviewed
  font-src 'self' data:;
  frame-ancestors 'none';
  base-uri 'self';
  form-action 'self';
  upgrade-insecure-requests;
  report-uri /csp-report
  ```
- **CORS**: API only accepts requests from the configured frontend origin; preflights return tightly scoped allowed headers.
- **API responses include**: `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: same-origin`, `Permissions-Policy: ...` denying camera/mic/geolocation/usb.
- **Internal-only routes** (`/internal/*`) enforced by mesh policy: only the orchestrator and workers' service identities may call them.

## 9. Input handling and injection defenses

- **Zod everywhere** for HTTP DTOs, BullMQ payloads, AI outputs, and configuration.
- **No raw SQL in apps**; ESLint rule blocks direct `prisma.$queryRaw` outside `packages/db`. Inside `packages/db`, raw SQL must go through tagged template helpers that parameterize and assert no string-interpolated identifiers from user input.
- **HTML rendering**: the frontend never `dangerouslySetInnerHTML`s user-provided strings. Markdown rendering uses `unified` with a constrained sanitizer schema.
- **File uploads**: enforced MIME type whitelist (`pdf, docx, txt, png, jpg`), max size 10 MB for resumes, magic-byte verification, virus scan.
- **AI prompt injection**: untrusted text (job descriptions, platform-rendered content) is wrapped in `<UNTRUSTED>...</UNTRUSTED>` blocks; the system prompt instructs not to follow instructions inside them. Eval suite includes adversarial cases.
- **Data URI in assets**: never accepted as profile inputs (e.g., avatar uploads accept only file inputs that are stored to S3 and served via signed URL).

## 10. The audit chain

Every consequential action writes one `audit_log` row. The chain is hash-linked:

```
audit_log.hash = SHA-256(prev_hash || canonical_serialize(row_minus_hash))
```

A trigger enforces it on `INSERT`. `UPDATE` and `DELETE` on `audit_log` are revoked from every role except a one-shot operator role used in approved retention pruning. A daily verifier job recomputes the chain and emits a metric (`audit_chain_intact`); if it goes false, an alert fires.

The audit log is the source of truth for:
- "Who changed this profile?" (`profile.update` events with field-level diff).
- "When did the user grant resume edits on LinkedIn?" (`permission.grant`).
- "When was a credential read?" (`credentials.redeem` includes the worker identity, not the credential).
- "When did the run pause and why?" (`run.pause` with reason).

## 11. Logging, redaction, and observability

- **Structured logs** (JSON via Pino). Every line carries `traceId, spanId, userId? (when authenticated), runId? (when present), service`.
- **Redaction**: `packages/shared-logger` ships a Pino redaction config that masks values for keys `password, secret, token, cipher, cipher_aad, dek, kek, vault_*, phone, phone_e164, phone_e164_enc, dob, date_of_birth, address, address_enc, ssn, aadhaar`. Object keys matching `*_enc` are stripped entirely from log output.
- **PII allowlist for known-safe paths**: e.g., the user's email is allowed in auth audit lines because the user *is* the email.
- **Sampling**: error logs are unsampled; debug-level logs are sampled at 10% in production.
- **Trace IDs** propagate from the client through every service. The frontend's error UI shows the trace id so support tickets are immediately correlatable.
- **Security event stream** (`security_events`) is separate from regular logs and goes to a more restrictive retention bucket. Events: failed login, MFA enroll/disable, session revoke, credential read, permission grant, captcha encountered, rate-limit triggered, anomaly detected.
- **Metrics** exclude any user-identifying labels except hashes (`user_id_hash`).

## 12. Artifact redaction (screenshots, DOM snapshots)

Screenshots taken during apply flows can contain SSN-like fields, OTPs, and password fields. Before persistence:

- The adapter declares `sensitiveSelectors` (e.g., `input[type=password]`, fields with `aria-label` matching a curated regex of sensitive labels).
- The worker queries the DOM for those selectors' bounding boxes immediately before the screenshot.
- A **server-side blur step** redacts those rectangles in-process before the image is uploaded to S3.
- The unredacted bitmap is never written to disk; the buffer is wiped.

DOM snapshots have a similar redaction: input values inside `sensitiveSelectors` are replaced with `[REDACTED]` before serialization.

## 13. Rate limiting and abuse controls

- **Token-bucket per principal** (`user_id` if authed; IP otherwise) for general endpoints.
- **Stricter buckets** for `/auth/*`: 5 sign-in attempts / 5 minutes / IP and per-user; 3 password resets / hour / user.
- **Run start cap**: 10 starts / hour / user (prevents an automation-against-our-API loop).
- **AI cost cap**: enforced by the cost governor (Phase 7) in addition to per-call rate.
- **Anomaly detection** on the `security_events` stream: spikes in failed logins, unusual geographies, sudden high CAPTCHA frequency. Tuned in M8.

## 14. Service-to-service auth

Inside the cluster:
- **Linkerd** mesh provides mTLS automatically. Service identity is the SPIFFE ID derived from the Kubernetes ServiceAccount.
- **Short-lived JWTs** for application-layer authentication, signed by the API gateway with `kek/jwt/internal`. Claims carry `user_id`, `purpose`, `expires_at` (≤ 5 minutes for worker tokens, ≤ 60 seconds for vault redemption). Tokens are bound to the calling service's SPIFFE ID via the `aud` claim.
- A worker that calls the AI service includes a JWT minted for the user it is currently working on; the AI service refuses calls without a valid user-scoped token.

## 15. Database security posture (recap + extensions to Phase 3)

Roles:
- `apex_app` — used by API, orchestrator, AI service, analytics, workers (with subset). DML on app tables; **no write/update/delete on `audit_log`**; no TRUNCATE.
- `apex_audit_writer` — used by services that log audit rows; INSERT-only on `audit_log`.
- `apex_audit_reader` — read-only on `audit_log`; used by the audit verifier and the user-facing Activity API.
- `apex_readonly` — analytics dashboards.
- `apex_owner` — migrations only; rotated frequently; password retrieved from Vault per-deployment.

Other:
- `pg_audit` enabled for SELECTs on `personal_info`, `platform_credentials`, `qa_memory` (when category is sensitive). The events flow into `audit_log` via a CDC bridge.
- Connection pool credentials rotate weekly via Vault Database secrets engine; PgBouncer reloads.
- Dev databases never receive production data; refresh from staging is allowed only after a scrubbing job runs (PII fields nulled or fake-substituted by `tools/db-scrub/`).
- Backups are encrypted client-side with `kek/backups`; the cold storage location does not have a path back into our identity system.

## 16. Supply chain security

- **Dependencies**: `pnpm` with strict lockfile. CI rejects any drift. `npm audit` style scanning via `osv-scanner` and `socket.dev` GitHub action; high/critical findings block merge.
- **Provenance**: every container image is built reproducibly in CI and signed with `cosign` (Sigstore). Images deployed to k8s are verified by an admission controller.
- **SBOMs**: generated per image (CycloneDX) and stored alongside the image in the registry.
- **Pinned base images**: digest-pinned, never `:latest`. Renovate automation proposes updates with diff context.
- **Build isolation**: CI runners do not have access to production secrets. Test secrets are scoped to a sandbox project.
- **Code review**: two-reviewer rule on `apps/api/auth`, `packages/crypto`, `packages/vault-client`, `apps/automation-worker/leases`, and any change to migrations. CODEOWNERS enforced.
- **Secrets scanning**: `gitleaks` pre-commit and CI; positive matches block commit/merge.
- **No `eval`, no dynamic `require`** in TypeScript packages; ESLint forbids `node:vm` outside specific blessed paths.

## 17. Network policy and least privilege at the cluster level

- Default deny on the cluster network; all flows are explicit (`NetworkPolicy`).
- The web app pod has egress to the API only.
- The API has egress to PG, Redis, Vault, AI service, S3.
- The orchestrator has egress to PG, Redis, Vault, AI service.
- Workers have egress to platform domains (allowlisted), Vault, AI service, S3, Redis.
- The AI service has egress to the chosen LLM providers (allowlisted) and PG, Redis, Vault.
- Nothing has cluster-wide read on Kubernetes API; service accounts are scoped.

## 18. Incident response

- **Runbooks** in `docs/runbooks/` (filled M9): credential leak suspected, KMS unreachable, ransomware on a host, mass selector drift, anomaly spike, lost backup key, audit chain tampering, AI provider compromise, hostile dependency.
- **Severity**: SEV1–4 with target response times.
- **Communication**: status page + email to affected users for any incident touching Tier 0/1 assets, within 72 hours per typical regulatory baselines (configurable in self-host).
- **Forensics**: a "freeze" mode that stops new writes to `applications`, `qa_memory`, and `platform_sessions` while keeping reads available; activated by a single command.
- **Drills**: quarterly tabletop, twice-yearly full restore drill from cold backup.

## 19. Privacy & data lifecycle

- **Data minimization**: we collect only what we use. Optional fields are visibly optional. Sensitive fields are off by default and require explicit MFA-protected entry.
- **Right to access**: `POST /me/export` produces a complete user dump.
- **Right to deletion**: soft delete + 30-day grace + hard delete with DEK destruction. Audit log retains tombstones with non-PII metadata only.
- **Retention**:
  - Resumes: kept until the user deletes them, then 30 days, then hard-deleted.
  - Application screenshots: 180 days for non-submitted, 7 years for submitted (legal).
  - AI decisions: 13 weeks online, then archived encrypted; full retention as long as the user account exists.
  - Audit log: 7 years.
- **Geographic boundaries**: in self-host, the operator chooses where data lives. In our hosted offering (M9), default region per user; cross-region replication only with consent.

## 20. The "what stops X" mental model

For quick recall, here is what stops the most common attempts:

| Attempt | What stops it |
| --- | --- |
| Stolen DB dump | Per-user DEKs are wrapped by KEK in Vault; ciphertext is opaque without Vault. |
| Stolen single host | Host has no KEK; can read its own working ciphertext only for the running session DEK in memory; reboot wipes. |
| Stolen worker pod | Worker has no DEK and no long-lived credentials; only short-lived leases for the task it is doing now. |
| Compromised dependency | Pinned, signed, scanned, SBOM-tracked images; admission controller refuses unknown digests. |
| CSRF on a money-equivalent action | SameSite cookie + double-submit token + `__Host-` prefix + step-up MFA on sensitive ops. |
| Phishing the user's password | WebAuthn primary; password alone insufficient (MFA enforced); breached-password check refuses common ones. |
| Replayed session cookie | DB stores hash of session; cookie scope `__Host-`; revocation propagates via Pub/Sub. |
| Audit log tampering | Append-only, hash-chained, role-restricted; daily verifier alerts on break. |
| Prompt injection from a job site | Untrusted block + system instruction + adversarial evals; structured-output validation. |
| AI overspend | Cost governor with daily ceiling and graceful degradation. |
| One user reading another's data | Repository-level `WHERE user_id = ...` enforcement, ESLint rule, per-user DEK so even leaked rows are unreadable. |
| Lost laptop with the app open | Idle timeout; cookie cleared on browser close (HttpOnly + session not persistent); WebAuthn re-prompts. |

## 21. Tradeoffs accepted

- **Self-hosted Vault.** More to operate than a managed KMS-only solution; necessary because we want envelope crypto with per-purpose subkeys and fine-grained leases.
- **No SMS MFA.** Worse for a small set of users; a hard line against SIM-swap.
- **WebAuthn first.** More onboarding friction than email-link magic; significantly stronger.
- **Per-user DEK wipes credentials on account delete forever.** Harsh by design; the user explicitly opts in to this irrevocability when deleting.
- **Egress allowlist for workers.** A burden when adding a new platform; cheap insurance against worker compromise.
- **mTLS everywhere internal.** Operational complexity vs blast radius reduction; service mesh automates most of it.
- **Pessimistic step-up MFA.** A few extra prompts per sensitive operation; we accept the friction.

## 22. What this phase deliberately does not decide

- Specific Vault policies' HCL — they ship in M0 with the Vault chart values.
- Specific WebAuthn library — chosen at M1 implementation.
- The customer-facing security FAQ — drafted at M9 launch.
- Penetration test cadence and provider — scheduled at M9.
