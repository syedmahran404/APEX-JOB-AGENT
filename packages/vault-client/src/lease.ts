// Lease + redeem flow for credential access by workers.
//
// Reference: docs/architecture/08-security-architecture.md §6.2.
//
// 1. Orchestrator: POST /vault/lease  → { redemption_token, expires_at }.
// 2. Worker:        POST /vault/redeem → { credential_payload }.
// 3. Credential plaintext lives in worker memory for seconds; wiped after use.
//
// In Phase 1 we ship the typed client surface. The actual server endpoints
// land in apps/api Phase 2 once the workers exist; this module defines the
// envelope so both sides stay in sync.

import { z } from 'zod';

export const LeaseRequest = z.object({
  userId: z.string().uuid(),
  platformKey: z.string(),
  purpose: z.enum(['login', 'refresh-session', 'profile-edit']),
  /** Maximum lifetime of the redemption token. The server may shorten it. */
  ttlSec: z.number().int().min(30).max(900).default(300),
});
export type LeaseRequest = z.infer<typeof LeaseRequest>;

export const LeaseResponse = z.object({
  leaseId: z.string().uuid(),
  /** One-time-use, time-limited token. Treat as bearer; do not log. */
  redemptionToken: z.string().min(32),
  expiresAt: z.string().datetime(),
});
export type LeaseResponse = z.infer<typeof LeaseResponse>;

export const RedeemRequest = z.object({
  redemptionToken: z.string().min(32),
});
export type RedeemRequest = z.infer<typeof RedeemRequest>;

export const RedeemResponse = z.object({
  /** Platform login bundle. Never persist; wipe on use. */
  username: z.string(),
  password: z.string(),
  /** Optional MFA seed if our copy is in scope. */
  totpSeed: z.string().optional(),
  /** Server-issued correlation id for the audit log. */
  auditId: z.string().uuid(),
});
export type RedeemResponse = z.infer<typeof RedeemResponse>;
