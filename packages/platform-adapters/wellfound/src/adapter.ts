// Wellfound adapter (formerly AngelList Talent) — Phase 2 scaffold.
//
// Wellfound is a startup-heavy SPA. The application form is React-driven;
// adapter authors should be ready for client-side route changes during
// the apply flow.

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
export const WELLFOUND_BASE_URL = 'https://wellfound.com';
export const WELLFOUND_LOGIN_URL = `${WELLFOUND_BASE_URL}/login`;

export const WELLFOUND_LOGGED_IN_INDICATOR: LayeredSelector = {
  name: 'wellfound-logged-in-indicator',
  layers: [
    { selector: 'a[href="/jobs"]' },
    { selector: 'div[data-test="UserMenu"]' },
  ],
};

export const WELLFOUND_SEARCH_RESULTS_LIST: LayeredSelector = {
  name: 'wellfound-search-results-list',
  layers: [
    { selector: 'div[data-test="JobSearchCard"]' },
    { selector: 'div.styles_component___UCLp' },
  ],
};

export const WELLFOUND_APPLY_BUTTON: LayeredSelector = {
  name: 'wellfound-apply-button',
  layers: [
    { selector: 'button[data-test="JobActionButton"]', visible: true },
    { selector: 'button.styles_apply__nF4m4', visible: true },
  ],
};

export function buildCanonicalKey(input: {
  company: string | null;
  title: string;
  location: string | null;
}): string {
  const employer = (input.company ?? '')
    .toLowerCase()
    .replace(/\b(inc\.?|llc|ltd\.?|gmbh|corp\.?)\b/g, ' ')
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

export class WellfoundAdapter extends BasePlatformAdapter {
  override readonly key: PlatformKey = 'wellfound';
  override readonly version = ADAPTER_VERSION;
  override readonly capabilities: AdapterCaps = {
    quickApply: false,
    multiStep: true,
    profileEdit: false,
    resumeUpload: true,
    atsDetection: false,
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

export const wellfoundAdapter = new WellfoundAdapter();
