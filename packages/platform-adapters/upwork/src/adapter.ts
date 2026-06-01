// Upwork adapter — Phase 2 scaffold.
//
// On Upwork, "applying" means submitting a PROPOSAL to a job posting. The
// shape is divergent from regular ATS flows: the user sets an hourly /
// fixed rate, writes a cover letter, and may answer pre-screening
// questions. Capability flags reflect this distinction.

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
export const UPWORK_BASE_URL = 'https://www.upwork.com';
export const UPWORK_LOGIN_URL = `${UPWORK_BASE_URL}/ab/account-security/login`;
export const UPWORK_FREELANCER_HOME = `${UPWORK_BASE_URL}/nx/find-work/best-matches`;

export const UPWORK_LOGGED_IN_INDICATOR: LayeredSelector = {
  name: 'upwork-logged-in-indicator',
  layers: [
    { selector: 'a[data-test="user-menu"]' },
    { selector: 'div[data-test="UserMenu"]' },
  ],
};

export const UPWORK_JOB_LIST: LayeredSelector = {
  name: 'upwork-job-list',
  layers: [
    { selector: 'section[data-test="JobsList"] article' },
    { selector: 'div.job-tile' },
  ],
};

export const UPWORK_SUBMIT_PROPOSAL_BUTTON: LayeredSelector = {
  name: 'upwork-submit-proposal-button',
  layers: [
    { selector: 'button[data-test="submit-proposal"]', visible: true },
    { selector: 'button[type="submit"][aria-label*="Submit" i]', visible: true },
  ],
};

export function buildCanonicalKey(input: {
  company: string | null;
  title: string;
  location: string | null;
}): string {
  // Upwork client identity is ephemeral. We canonicalize on title +
  // (best-effort) client name; without a client name we fall back to a
  // hash of the title — different jobs from the same client are often
  // genuinely distinct, so cross-platform dedupe rarely fires here.
  const employer = (input.company ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const title = input.title
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (title.length === 0) return '';
  const e = employer.length > 0 ? employer : 'upwork-client';
  void input.location; // Upwork is remote-first; location is rarely meaningful for dedupe.
  return `${e}::${title}::remote`;
}

export class UpworkAdapter extends BasePlatformAdapter {
  override readonly key: PlatformKey = 'upwork';
  override readonly version = ADAPTER_VERSION;
  override readonly capabilities: AdapterCaps = {
    quickApply: false,
    multiStep: true,
    profileEdit: false,
    resumeUpload: false,
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

export const upworkAdapter = new UpworkAdapter();
