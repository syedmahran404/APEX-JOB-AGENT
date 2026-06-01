// Internshala adapter — Phase 2 scaffold.
//
// Internshala is India-focused; primarily internships + entry-level. The
// adapter scaffold conforms to the engine contract; capabilities flagged
// recon-pending until canary verification.

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
export const INTERNSHALA_BASE_URL = 'https://internshala.com';
export const INTERNSHALA_LOGIN_URL = `${INTERNSHALA_BASE_URL}/login/student`;

export const INTERNSHALA_LOGGED_IN_INDICATOR: LayeredSelector = {
  name: 'internshala-logged-in-indicator',
  layers: [
    { selector: 'a[href*="/student/profile"]' },
    { selector: 'div.user_profile' },
  ],
};

export const INTERNSHALA_SEARCH_RESULTS_LIST: LayeredSelector = {
  name: 'internshala-search-results-list',
  layers: [
    { selector: 'div.individual_internship' },
    { selector: 'div[id^="individual_internship_"]' },
  ],
};

export const INTERNSHALA_APPLY_BUTTON: LayeredSelector = {
  name: 'internshala-apply-button',
  layers: [
    { selector: 'button#continue_button', visible: true },
    { selector: 'button.btn-primary[id*="apply" i]', visible: true },
    { selector: 'a.btn[href*="apply" i]', visible: true },
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
    .replace(/\b(intern|internship|trainee)\b/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (employer.length === 0 || title.length === 0) return '';
  const loc = (input.location ?? '').toLowerCase();
  const bucket = /\bwork from home\b|\bremote\b/.test(loc) ? 'remote' : (loc.split(/[, ]/)[0] ?? 'unknown');
  return `${employer}::${title}::${bucket}`;
}

export class InternshalaAdapter extends BasePlatformAdapter {
  override readonly key: PlatformKey = 'internshala';
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

export const internshalaAdapter = new InternshalaAdapter();
