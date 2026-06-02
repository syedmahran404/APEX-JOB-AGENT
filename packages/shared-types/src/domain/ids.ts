// Branded ID types backed by Zod string schemas.

import { z } from 'zod';

export const Uuid = z.string().uuid();
export type Uuid = z.infer<typeof Uuid>;

export const TenantId = Uuid.brand<'TenantId'>();
export type TenantId = z.infer<typeof TenantId>;

export const UserId = Uuid.brand<'UserId'>();
export type UserId = z.infer<typeof UserId>;

export const SessionId = Uuid.brand<'SessionId'>();
export type SessionId = z.infer<typeof SessionId>;

export const PlatformId = Uuid.brand<'PlatformId'>();
export type PlatformId = z.infer<typeof PlatformId>;

export const RoleId = Uuid.brand<'RoleId'>();
export type RoleId = z.infer<typeof RoleId>;

export const PermissionId = Uuid.brand<'PermissionId'>();
export type PermissionId = z.infer<typeof PermissionId>;

/** ULID for client-facing opaque identifiers (URL-safe, sortable). */
export const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
export type Ulid = z.infer<typeof Ulid>;
