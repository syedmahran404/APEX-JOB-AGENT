// Public-facing user shapes. Sensitive fields live in @apex/shared-types/domain
// only as opaque references; the API never returns plaintext PII.

import { z } from 'zod';
import { TenantId, UserId } from './ids.js';

export const UserStatus = z.enum(['active', 'suspended', 'deleted']);
export type UserStatus = z.infer<typeof UserStatus>;

export const EmailStatus = z.enum(['unverified', 'verified', 'bouncing', 'complained', 'suppressed']);
export type EmailStatus = z.infer<typeof EmailStatus>;

export const PublicUser = z.object({
  id: UserId,
  tenantId: TenantId,
  email: z.string().email(),
  displayName: z.string().min(1),
  status: UserStatus,
  emailStatus: EmailStatus,
  emailVerifiedAt: z.coerce.date().nullable(),
  lastLoginAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});
export type PublicUser = z.infer<typeof PublicUser>;
