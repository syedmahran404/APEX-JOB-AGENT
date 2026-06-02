// LinkedInAdapter — wires the pure parsers + selector catalog into the
// PlatformAdapter contract.
//
// IMPORTANT (scope honesty): the methods that must drive a real browser
// (ensureSession, refreshSession, search, parseJob-over-network, canApply, apply,
// uploadResume) require a Playwright page supplied by apps/automation-worker.
// Until the worker's browser runtime lands, those methods reject/throw a typed
// DependencyError (from @apex/shared-errors) rather than fabricate untested
// automation. The PURE logic (parseListing, selector catalog, capability
// declaration, apply-kind detection) is fully implemented and unit-tested.
//
// Reference: docs/architecture/06-automation-engine.md §3, §4.

import {
  BasePlatformAdapter,
  type AdapterCaps,
  type AdapterContext,
  type ApplicationPlan,
  type ApplyEligibility,
  type ApplyEvent,
  type DiscoveredJob,
  type JobDetail,
  type PlatformKey,
  type SearchFilters,
  type SessionState,
} from '@apex/automation-core';
import { DependencyError } from '@apex/shared-errors';
import { LINKEDIN_SELECTORS, LINKEDIN_SENSITIVE_SELECTORS } from './selectors.js';
import { parseListing as parseListingPure, type RawLinkedInListing } from './parse.js';

/** Adapter version — bump on any selector or flow change (adapter-version pinning). */
export const LINKEDIN_ADAPTER_VERSION = '0.1.0';

export const LINKEDIN_CAPS: AdapterCaps = {
  quickApply: true,
  multiStep: true,
  profileEdit: true, // gated by permission at the orchestrator
  resumeUpload: true,
  profileRead: true,
  proposalBased: false,
};

/**
 * Build the typed error thrown by browser-driving methods that require a
 * Playwright runtime the worker has not yet supplied. Uses the shared-errors
 * hierarchy (the browser runtime is the unavailable "dependency").
 */
export function browserRuntimeRequired(method: string): DependencyError {
  return new DependencyError(
    'playwright-runtime',
    `LinkedInAdapter.${method} requires a Playwright runtime provided by ` +
      `apps/automation-worker; it cannot run in a browser-free context.`,
  );
}

export class LinkedInAdapter extends BasePlatformAdapter {
  readonly key: PlatformKey = 'linkedin';
  readonly version = LINKEDIN_ADAPTER_VERSION;
  readonly capabilities = LINKEDIN_CAPS;

  /** Selector catalog + sensitive-selector list (consumed by the worker). */
  readonly selectors = LINKEDIN_SELECTORS;
  readonly sensitiveSelectors = LINKEDIN_SENSITIVE_SELECTORS;

  // ----- Pure: implemented here. -----

  /**
   * Normalize a raw search-result item. The worker extracts the raw strings via
   * the selector catalog and passes them here as an opaque `unknown`.
   */
  override parseListing(ctx: AdapterContext, raw: unknown): DiscoveredJob {
    return parseListingPure(raw as RawLinkedInListing, ctx.clock.now());
  }

  // ----- Browser-driving: supplied by the worker runtime (Phase 2 wiring). -----

  override ensureSession(_ctx: AdapterContext): Promise<SessionState> {
    return Promise.reject(browserRuntimeRequired('ensureSession'));
  }

  override refreshSession(_ctx: AdapterContext): Promise<SessionState> {
    return Promise.reject(browserRuntimeRequired('refreshSession'));
  }

  override search(_ctx: AdapterContext, _filters: SearchFilters): AsyncIterable<DiscoveredJob> {
    throw browserRuntimeRequired('search');
  }

  override parseJob(_ctx: AdapterContext, _jobUrl: string): Promise<JobDetail> {
    return Promise.reject(browserRuntimeRequired('parseJob'));
  }

  override canApply(_ctx: AdapterContext, _job: JobDetail): Promise<ApplyEligibility> {
    return Promise.reject(browserRuntimeRequired('canApply'));
  }

  override apply(_ctx: AdapterContext, _job: JobDetail, _plan: ApplicationPlan): AsyncIterable<ApplyEvent> {
    throw browserRuntimeRequired('apply');
  }
}
