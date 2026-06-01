// Platform account / session shapes.

import { z } from 'zod';
import { PlatformId, TenantId, Uuid, UserId } from './ids.js';

export const PlatformAccountStatus = z.enum([
  'connected',
  'disconnected',
  'expired',
  'blocked',
]);
export type PlatformAccountStatus = z.infer<typeof PlatformAccountStatus>;

export const SessionHealth = z.enum(['fresh', 'stale', 'blocked', 'unknown']);
export type SessionHealth = z.infer<typeof SessionHealth>;

export const AutonomousMode = z.enum(['assisted', 'autonomous']);
export type AutonomousMode = z.infer<typeof AutonomousMode>;

export const PlatformAccount = z.object({
  id: Uuid,
  tenantId: TenantId,
  userId: UserId,
  platformId: PlatformId,
  displayLabel: z.string().nullable(),
  status: PlatformAccountStatus,
  lastLoginAt: z.coerce.date().nullable(),
  lastSessionCheckAt: z.coerce.date().nullable(),
});
export type PlatformAccount = z.infer<typeof PlatformAccount>;

export const PlatformPermission = z.object({
  userId: UserId,
  platformId: PlatformId,
  allowApply: z.boolean(),
  allowProfileEdit: z.boolean(),
  allowResumeEdit: z.boolean(),
  autonomousMode: AutonomousMode,
  dailyApplicationCap: z.number().int().positive().nullable(),
  thresholdScore: z.number().int().min(0).max(100),
  pacingProfile: z.string(),
});
export type PlatformPermission = z.infer<typeof PlatformPermission>;

export const PlatformSession = z.object({
  id: Uuid,
  accountId: Uuid,
  storageUri: z.string().min(1),
  expiresAt: z.coerce.date().nullable(),
  health: SessionHealth,
  lastUsedAt: z.coerce.date().nullable(),
});
export type PlatformSession = z.infer<typeof PlatformSession>;
