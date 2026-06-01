// Job domain shapes. Public-facing — no PII; URLs and titles are user-visible.

import { z } from 'zod';
import { PlatformId, Uuid } from './ids.js';

export const FreshnessTier = z.enum(['t5h', 't12h', 't24h', 't5d', 'stale']);
export type FreshnessTier = z.infer<typeof FreshnessTier>;

/** The configurable freshness window cutoffs in MINUTES (audit + Phase 6 §9). */
export const FRESHNESS_WINDOWS_MIN = {
  t5h: 5 * 60,
  t12h: 12 * 60,
  t24h: 24 * 60,
  t5d: 5 * 24 * 60,
} as const satisfies Readonly<Record<Exclude<FreshnessTier, 'stale'>, number>>;

/** Tier comparator: lower number = fresher = higher priority. */
export const FRESHNESS_PRIORITY: Readonly<Record<FreshnessTier, number>> = {
  t5h: 1,
  t12h: 2,
  t24h: 3,
  t5d: 4,
  stale: 99,
} as const;

export const RemoteKind = z.enum(['remote', 'hybrid', 'onsite', 'any']);
export type RemoteKind = z.infer<typeof RemoteKind>;

export const Job = z.object({
  id: Uuid,
  tenantId: Uuid,
  platformId: PlatformId,
  externalId: z.string().min(1),
  url: z.string().url(),
  title: z.string().min(1),
  company: z.string().nullable(),
  location: z.string().nullable(),
  remoteKind: RemoteKind.nullable(),
  postedAt: z.coerce.date().nullable(),
  postedAtUncertain: z.boolean(),
  discoveredAt: z.coerce.date(),
  freshness: FreshnessTier.nullable(),
  descriptionMd: z.string().nullable(),
  applicants: z.number().int().nonnegative().nullable(),
  salaryMin: z.coerce.bigint().nullable(),
  salaryMax: z.coerce.bigint().nullable(),
  currency: z.string().length(3).nullable(),
  isQuickApply: z.boolean().nullable(),
  requiredSkills: z.array(z.string()),
  canonicalKey: z.string(),
});
export type Job = z.infer<typeof Job>;

/** Search filters submitted to a platform adapter's discovery flow. */
export const SearchFilters = z.object({
  query: z.string().min(1).max(256),
  locations: z.array(z.string()).default([]),
  remoteKinds: z.array(RemoteKind).default([]),
  minSalaryMinor: z.coerce.bigint().optional(),
  currency: z.string().length(3).optional(),
  postedWithinMin: z.number().int().positive().default(FRESHNESS_WINDOWS_MIN.t5d),
  /** Maximum listings to inspect during one discovery pass. */
  maxListings: z.number().int().positive().max(500).default(200),
});
export type SearchFilters = z.infer<typeof SearchFilters>;
