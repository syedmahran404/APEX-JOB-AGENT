// Job dedupe. Two layers:
//  1. Per-user per-platform: skip listings already in `job_seen` (external id).
//  2. Cross-platform canonical key (audit missing-feature §6): the same role at
//     the same company posted to multiple platforms collapses to one canonical
//     key so we apply once (first-applied-wins). Pure & deterministic.

import { createHash } from 'node:crypto';

/** Normalize a free-text token for canonical-key construction. */
export function normalizeToken(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/\b(inc|llc|ltd|limited|pvt|private|corp|co|gmbh)\b/g, '') // company suffixes
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Canonical cross-platform job key from (title, company, location). Same role at
 * the same company/location yields the same key regardless of platform.
 */
export function canonicalJobKey(input: { title: string; company: string; location?: string | undefined }): string {
  const title = normalizeToken(input.title);
  const company = normalizeToken(input.company);
  const location = normalizeToken(input.location ?? '');
  const basis = `${company}|${title}|${location}`;
  return createHash('sha256').update(basis).digest('hex').slice(0, 32);
}

export interface SeenIndex {
  /** Platform-scoped external ids already seen for this user. */
  externalIds: ReadonlySet<string>;
  /** Canonical keys already applied/queued for this user (cross-platform). */
  canonicalKeys: ReadonlySet<string>;
}

export interface DedupeCandidate {
  externalId: string;
  title: string;
  company: string;
  location?: string | undefined;
}

export interface DedupeResult<T> {
  fresh: T[];
  duplicates: Array<{ job: T; reason: 'external_id_seen' | 'canonical_key_seen' }>;
}

/**
 * Partition candidates into fresh vs duplicate. Within a single batch, the first
 * occurrence of a canonical key wins; later ones are duplicates (first-applied-wins).
 */
export function dedupeJobs<T extends DedupeCandidate>(candidates: T[], seen: SeenIndex): DedupeResult<T> {
  const fresh: T[] = [];
  const duplicates: DedupeResult<T>['duplicates'] = [];
  const batchKeys = new Set<string>(seen.canonicalKeys);

  for (const job of candidates) {
    if (seen.externalIds.has(job.externalId)) {
      duplicates.push({ job, reason: 'external_id_seen' });
      continue;
    }
    const key = canonicalJobKey(job);
    if (batchKeys.has(key)) {
      duplicates.push({ job, reason: 'canonical_key_seen' });
      continue;
    }
    batchKeys.add(key);
    fresh.push(job);
  }
  return { fresh, duplicates };
}
