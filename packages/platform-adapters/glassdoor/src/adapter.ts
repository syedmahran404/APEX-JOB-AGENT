// Glassdoor adapter — Phase 2 scaffold.
//
// Glassdoor frequently delegates to employer-specific ATS forms (Workday,
// Greenhouse, Lever). The adapter's eligibility check uses the shared ATS
// detector from automation-core; when an external ATS is detected the
// engine emits `skipped_external_ats` cleanly.

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

export const GLASSDOOR_BASE_URL = 'https://www.glassdoor.com';
export const GLASSDOOR_LOGIN_URL = `${GLASSDOOR_BASE_URL}/profile/login_input.htm`;

export const GLASSDOOR_LOGGED_IN_INDICATOR: LayeredSelector = {
  name: 'glassdoor-logged-in-indicator',
  layers: [
    { selector: 'div[data-test="user-account"]' },
    { selector: 'a[data-test="user-profile-link"]' },
  ],
};

export const GLASSDOOR_SEARCH_RESULTS_LIST: LayeredSelector = {
  name: 'glassdoor-search-results-list',
  layers: [
    { selector: 'li[data-test="jobListing"]' },
    { selector: 'div[data-test="job-card"]' },
  ],
};

export const GLASSDOOR_APPLY_BUTTON: LayeredSelector = {
  name: 'glassdoor-apply-button',
  layers: [
    { selector: 'button[data-test="easy-apply-button"]', visible: true },
    { selector: 'a[data-test="applyButton"]', visible: true },
  ],
};

export function buildCanonicalKey(input: {
  company: string | null;
  title: string;
  location: string | null;
}): string {
  const employer = (input.company ?? '')
    .toLowerCase()
    .replace(/\b(inc\.?|llc|ltd\.?|gmbh|corp\.?|co\.?)\b/g, ' ')
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
  const bucket = /\bremote\b/.test(loc) ? 'remote' : (loc.split(/[, ]/)[0] ?? 'unknown');
  return `${employer}::${title}::${bucket}`;
}

export class GlassdoorAdapter extends BasePlatformAdapter {
  override readonly key: PlatformKey = 'glassdoor';
  override readonly version = ADAPTER_VERSION;
  override readonly capabilities: AdapterCaps = {
    quickApply: false,
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

export const glassdoorAdapter = new GlassdoorAdapter();
