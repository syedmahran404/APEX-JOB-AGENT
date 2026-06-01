// Foundit adapter (formerly Monster India) — Phase 2 scaffold.

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
export const FOUNDIT_BASE_URL = 'https://www.foundit.in';
export const FOUNDIT_LOGIN_URL = `${FOUNDIT_BASE_URL}/seeker/login`;

export const FOUNDIT_LOGGED_IN_INDICATOR: LayeredSelector = {
  name: 'foundit-logged-in-indicator',
  layers: [
    { selector: 'a[href*="/seeker/profile"]' },
    { selector: 'div.user-info' },
  ],
};

export const FOUNDIT_SEARCH_RESULTS_LIST: LayeredSelector = {
  name: 'foundit-search-results-list',
  layers: [
    { selector: 'div.srpResultCardContainer' },
    { selector: 'div[data-job-id]' },
  ],
};

export const FOUNDIT_APPLY_BUTTON: LayeredSelector = {
  name: 'foundit-apply-button',
  layers: [
    { selector: 'button.applyButton', visible: true },
    { selector: 'button[data-action*="apply" i]', visible: true },
  ],
};

export function buildCanonicalKey(input: {
  company: string | null;
  title: string;
  location: string | null;
}): string {
  const employer = (input.company ?? '')
    .toLowerCase()
    .replace(/\b(pvt\.?|ltd\.?|inc\.?|private|limited)\b/g, ' ')
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
  const bucket = /\b(remote|wfh)\b/.test(loc) ? 'remote' : (loc.split(/[, ]/)[0] ?? 'unknown');
  return `${employer}::${title}::${bucket}`;
}

export class FounditAdapter extends BasePlatformAdapter {
  override readonly key: PlatformKey = 'foundit';
  override readonly version = ADAPTER_VERSION;
  override readonly capabilities: AdapterCaps = {
    quickApply: true,
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

export const founditAdapter = new FounditAdapter();
