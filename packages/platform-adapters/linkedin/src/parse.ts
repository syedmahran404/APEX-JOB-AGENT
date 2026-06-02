// LinkedIn pure parsers. These take the raw, already-extracted DOM strings (what
// the worker scrapes via selectors) and normalize them into the @apex/automation-core
// DiscoveredJob / JobDetail shapes. No browser here — fully unit-testable against
// offline fixtures.
//
// Reference: docs/architecture/06-automation-engine.md §9, §10.

import {
  type ApplyKind,
  type DiscoveredJob,
  type JobDetail,
  type RemoteKind,
  resolvePostedAt,
} from '@apex/automation-core';
import { ValidationError } from '@apex/shared-errors';

export const LINKEDIN_KEY = 'linkedin' as const;

/** Raw fields extracted from a single search-result list item. */
export interface RawLinkedInListing {
  /** href of the job link, e.g. https://www.linkedin.com/jobs/view/3856...  */
  url?: string | undefined;
  /** data-job-id / entity urn when present. */
  entityId?: string | undefined;
  title?: string | undefined;
  company?: string | undefined;
  location?: string | undefined;
  /** Relative phrase, e.g. "2 hours ago". */
  postedRelative?: string | undefined;
  /** Absolute datetime attribute, e.g. time[datetime]. */
  postedAbsolute?: string | undefined;
  /** Workplace badge text, e.g. "Remote", "Hybrid", "On-site". */
  workplaceType?: string | undefined;
}

/** Raw fields extracted from a job detail page. */
export interface RawLinkedInJob extends RawLinkedInListing {
  description?: string | undefined;
  salaryText?: string | undefined;
  /** Apply button label, e.g. "Easy Apply" or "Apply on company website". */
  applyButtonText?: string | undefined;
  /** True when the page shows an "Applied" badge. */
  alreadyApplied?: boolean | undefined;
  /** True when the job is shown as closed/no-longer-accepting. */
  closed?: boolean | undefined;
}

/** Extract the numeric LinkedIn job id from a job URL or entity urn. */
export function extractJobId(input: { url?: string | undefined; entityId?: string | undefined }): string | null {
  if (input.entityId) {
    const m = /(\d{6,})/.exec(input.entityId);
    if (m) return m[1]!;
  }
  if (input.url) {
    const m = /\/jobs\/view\/(?:[^/]*-)?(\d{6,})/.exec(input.url) ?? /currentJobId=(\d{6,})/.exec(input.url);
    if (m) return m[1]!;
  }
  return null;
}

export function normalizeRemoteKind(text: string | undefined): RemoteKind | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase();
  if (/remote/.test(t)) return 'remote';
  if (/hybrid/.test(t)) return 'hybrid';
  if (/on-?site|in office/.test(t)) return 'onsite';
  return undefined;
}

function requireField(value: string | undefined, field: string): string {
  const v = (value ?? '').trim();
  if (v === '') {
    throw new ValidationError(`LinkedIn parse: missing required field "${field}"`, [
      { path: [field], message: 'required', code: 'missing' },
    ]);
  }
  return v;
}

/** Normalize a raw search-result listing into a DiscoveredJob. `now` is injected. */
export function parseListing(raw: RawLinkedInListing, now: Date): DiscoveredJob {
  const externalId = extractJobId(raw);
  if (externalId === null) {
    throw new ValidationError('LinkedIn parse: could not derive job id from listing', [
      { path: ['externalId'], message: 'could not derive job id', code: 'unparseable' },
    ]);
  }
  const { postedAt, uncertain } = resolvePostedAt(
    { absoluteIso: raw.postedAbsolute, relativeText: raw.postedRelative },
    now,
  );
  const url = raw.url ?? `https://www.linkedin.com/jobs/view/${externalId}`;

  return {
    externalId,
    platformKey: LINKEDIN_KEY,
    title: requireField(raw.title, 'title'),
    company: requireField(raw.company, 'company'),
    location: raw.location?.trim() || undefined,
    url,
    postedAt,
    postedAtUncertain: uncertain,
    remoteKind: normalizeRemoteKind(raw.workplaceType),
  };
}

/** Detect the apply kind from the parsed detail-page raw fields. */
export function detectApplyKind(raw: RawLinkedInJob): ApplyKind {
  if (raw.alreadyApplied === true) return 'already_applied';
  if (raw.closed === true) return 'closed';
  const label = (raw.applyButtonText ?? '').toLowerCase();
  if (/easy apply/.test(label)) return 'quick';
  if (/apply on company website|apply on|company site/.test(label)) return 'external_redirect';
  if (/^apply$/.test(label.trim())) return 'multi_step';
  // No recognizable apply affordance → treat as closed (nothing to do).
  return 'closed';
}

/** Normalize a raw detail page into a JobDetail. `now` is injected. */
export function parseJob(raw: RawLinkedInJob, now: Date): JobDetail {
  const listing = parseListing(raw, now);
  return {
    ...listing,
    description: (raw.description ?? '').trim(),
    salaryText: raw.salaryText?.trim() || undefined,
    applyKind: detectApplyKind(raw),
  };
}
