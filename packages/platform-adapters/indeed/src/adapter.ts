// Indeed adapter — Phase 2 scaffold.
//
// Indeed is region-branched: indeed.com (US), indeed.co.in (India), etc.
// The adapter resolves the regional host from the user's preferred locale
// at first navigation. Selectors below are observed on indeed.com / co.in
// and are best-effort until canary verification.
//
// capabilities.verifiedAgainstLive = false → engine emits
// `skipped_recon_pending` until an operator turns this on.

import {
  BasePlatformAdapter,
  ReconPendingError,
  type AdapterCaps,
  type AdapterContext,
  type ApplicationPlan,
  type ApplyEligibility,
  type DiscoveredJob,
  type JobDetail,
  type LayeredSelector,
  type PlatformKey,
  type SubmitResult,
} from '@apex/automation-core';
import type { Domain } from '@apex/shared-types';

export const ADAPTER_VERSION = '0.1.0-recon-pending';

export const INDEED_HOSTS_BY_LOCALE: Readonly<Record<string, string>> = {
  'en-US': 'https://www.indeed.com',
  'en-GB': 'https://uk.indeed.com',
  'en-IN': 'https://in.indeed.com',
  'en-CA': 'https://ca.indeed.com',
  'en-AU': 'https://au.indeed.com',
};
export const INDEED_DEFAULT_HOST = INDEED_HOSTS_BY_LOCALE['en-US']!;

export const INDEED_LOGGED_IN_INDICATOR: LayeredSelector = {
  name: 'indeed-logged-in-indicator',
  layers: [
    { selector: 'a[href*="/account"]' },
    { selector: 'div[data-testid="loggedInUserDropdown"]' },
    { selector: 'a#auth-account-dropdown' },
  ],
};

export const INDEED_SEARCH_RESULTS_LIST: LayeredSelector = {
  name: 'indeed-search-results-list',
  layers: [
    { selector: 'div.job_seen_beacon' },
    { selector: 'div.cardOutline' },
    { selector: 'a.tapItem' },
  ],
};

export const INDEED_APPLY_BUTTON: LayeredSelector = {
  name: 'indeed-apply-button',
  layers: [
    { selector: 'button#indeedApplyButton', visible: true },
    { selector: 'button[id*="indeed-apply" i]', visible: true },
    { selector: 'a[aria-label*="Apply on company website" i]', visible: true },
  ],
};

export function buildCanonicalKey(input: {
  company: string | null;
  title: string;
  location: string | null;
}): string {
  const employer = (input.company ?? '')
    .toLowerCase()
    .replace(/\b(inc\.?|llc|ltd\.?|llp|gmbh|corp\.?|co\.?)\b/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const title = input.title
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(senior|sr\.?|junior|jr\.?|principal|staff|lead|i+|iii|iv|v)\b/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (employer.length === 0 || title.length === 0) return '';
  const loc = (input.location ?? '').toLowerCase();
  let bucket = 'unknown';
  if (/\b(remote|anywhere)\b/.test(loc)) bucket = 'remote';
  else if (/\b(san francisco|sf bay)\b/.test(loc)) bucket = 'sf-bay';
  else if (/\b(new york|nyc)\b/.test(loc)) bucket = 'nyc';
  else if (/\b(london|greater london)\b/.test(loc)) bucket = 'london';
  else if (/\b(bengaluru|bangalore)\b/.test(loc)) bucket = 'bengaluru';
  else if (/\b(mumbai|bombay)\b/.test(loc)) bucket = 'mumbai';
  else bucket = loc.split(/[, ]/)[0] ?? 'unknown';
  return `${employer}::${title}::${bucket}`;
}

export class IndeedAdapter extends BasePlatformAdapter {
  override readonly key: PlatformKey = 'indeed';
  override readonly version = ADAPTER_VERSION;
  override readonly capabilities: AdapterCaps = {
    quickApply: true,
    multiStep: true,
    profileEdit: false,
    resumeUpload: true,
    atsDetection: true,
    verifiedAgainstLive: false,
  };

  override async ensureSession(_ctx: AdapterContext): Promise<void> {
    void _ctx;
    throw new ReconPendingError(this.key, 'ensure-session not yet verified');
  }

  override async *search(
    _ctx: AdapterContext,
    _filters: Domain.SearchFilters,
  ): AsyncGenerator<DiscoveredJob, void, undefined> {
    void _ctx;
    void _filters;
    throw new ReconPendingError(this.key, 'search not yet verified');
  }

  override async parseJob(_ctx: AdapterContext, _jobUrl: string): Promise<JobDetail> {
    void _ctx;
    void _jobUrl;
    throw new ReconPendingError(this.key, 'parseJob not yet verified');
  }

  override async canApply(_ctx: AdapterContext, _job: JobDetail): Promise<ApplyEligibility> {
    void _ctx;
    void _job;
    return { kind: 'unsupported', reason: 'recon_pending' };
  }

  override async apply(
    _ctx: AdapterContext,
    _job: JobDetail,
    _plan: ApplicationPlan,
  ): Promise<SubmitResult> {
    void _ctx;
    void _job;
    void _plan;
    throw new ReconPendingError(this.key, 'apply not yet verified');
  }
}

export const indeedAdapter = new IndeedAdapter();
