// Naukri.com adapter — Phase 2 scaffold.
//
// Status: structurally complete; selectors are best-effort seeds based on
// public observation. capabilities.verifiedAgainstLive = false, so the
// engine cleanly emits `skipped_recon_pending` until the adapter-canary
// CI confirms selectors against the live site (audit fix C5/C6 + the
// recon-pending convention from the audit's revised plan §11).
//
// On first canary pass, an operator:
//   1. Confirms each layered selector resolves on the live site.
//   2. Tunes pacing if needed.
//   3. Bumps the version and flips `verifiedAgainstLive` to true.

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

export const NAUKRI_BASE_URL = 'https://www.naukri.com';
export const NAUKRI_LOGIN_URL = `${NAUKRI_BASE_URL}/nlogin/login`;
export const NAUKRI_HOME_URL = `${NAUKRI_BASE_URL}/`;

export const NAUKRI_LOGGED_IN_INDICATOR: LayeredSelector = {
  name: 'naukri-logged-in-indicator',
  layers: [
    { selector: 'a[href*="/myhome"]' },
    { selector: 'div.nI-gNb-drawer__container' },
    { selector: 'div[class*="user-name"]' },
  ],
};

export const NAUKRI_SEARCH_RESULTS_LIST: LayeredSelector = {
  name: 'naukri-search-results-list',
  layers: [
    { selector: 'div.srp-jobtuple-wrapper' },
    { selector: 'article.jobTuple' },
    { selector: 'div.jobTuple' },
  ],
};

export const NAUKRI_APPLY_BUTTON: LayeredSelector = {
  name: 'naukri-apply-button',
  layers: [
    { selector: 'button#apply-button', visible: true },
    { selector: 'button[id*="apply" i]', visible: true },
    { selector: 'a.apply-button', visible: true },
  ],
};

/** Canonical-key builder. Naukri's location strings are city-first. */
export function buildCanonicalKey(input: {
  company: string | null;
  title: string;
  location: string | null;
}): string {
  const employer = (input.company ?? '')
    .toLowerCase()
    .replace(/\b(pvt\.?|private|ltd\.?|limited|inc\.?|co\.?)\b/g, ' ')
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
  if (/\b(bengaluru|bangalore)\b/.test(loc)) bucket = 'bengaluru';
  else if (/\b(mumbai|bombay)\b/.test(loc)) bucket = 'mumbai';
  else if (/\b(noida|gurgaon|gurugram|delhi)\b/.test(loc)) bucket = 'ncr';
  else if (/\bpune\b/.test(loc)) bucket = 'pune';
  else if (/\bhyderabad\b/.test(loc)) bucket = 'hyderabad';
  else if (/\bchennai\b/.test(loc)) bucket = 'chennai';
  else if (/\b(remote|wfh|work from home)\b/.test(loc)) bucket = 'remote';
  else bucket = loc.split(/[, ]/)[0] ?? 'unknown';
  return `${employer}::${title}::${bucket}`;
}

export class NaukriAdapter extends BasePlatformAdapter {
  override readonly key: PlatformKey = 'naukri';
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

export const naukriAdapter = new NaukriAdapter();
