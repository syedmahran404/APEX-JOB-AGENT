// LinkedInAdapter — wires the BasePlatformAdapter to the per-flow modules.

import type { Domain } from '@apex/shared-types';
import {
  BasePlatformAdapter,
  type AdapterCaps,
  type AdapterContext,
  type ApplicationPlan,
  type ApplyEligibility,
  type DiscoveredJob,
  type JobDetail,
  type PlatformKey,
  type SubmitResult,
} from '@apex/automation-core';

import { ADAPTER_VERSION } from './version.js';
import { ensureLinkedInSession } from './flows/ensure-session.js';
import { searchLinkedIn } from './flows/search.js';
import { parseLinkedInJob } from './flows/parse-job.js';
import { canApplyLinkedIn } from './flows/can-apply.js';
import { applyLinkedIn } from './flows/apply.js';

export class LinkedInAdapter extends BasePlatformAdapter {
  override readonly key: PlatformKey = 'linkedin';
  override readonly version = ADAPTER_VERSION;
  override readonly capabilities: AdapterCaps = {
    quickApply: true,
    multiStep: true,
    profileEdit: false,           // Phase 6 enables under permission gate
    resumeUpload: true,
    atsDetection: true,
    /**
     * Selectors are derived from observed LinkedIn DOM patterns and the
     * adapter handles drift gracefully (SelectorDriftError → captured).
     * On first deployment, the adapter-canary CI job verifies discovery
     * against the live site; only after that signal flips does an
     * operator set this to true in production.
     */
    verifiedAgainstLive: false,
  };

  override async ensureSession(ctx: AdapterContext): Promise<void> {
    await ensureLinkedInSession(ctx);
  }

  override search(ctx: AdapterContext, filters: Domain.SearchFilters): AsyncIterable<DiscoveredJob> {
    return searchLinkedIn(ctx, filters);
  }

  override async parseJob(ctx: AdapterContext, jobUrl: string): Promise<JobDetail> {
    return parseLinkedInJob(ctx, jobUrl);
  }

  override async canApply(ctx: AdapterContext, job: JobDetail): Promise<ApplyEligibility> {
    return canApplyLinkedIn(ctx, job);
  }

  override async apply(
    ctx: AdapterContext,
    job: JobDetail,
    plan: ApplicationPlan,
  ): Promise<SubmitResult> {
    return applyLinkedIn(ctx, job, plan);
  }
}

export const linkedinAdapter = new LinkedInAdapter();
