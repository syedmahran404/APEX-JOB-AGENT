// search — async generator producing DiscoveredJob items from LinkedIn's
// jobs search surface.
//
// Strategy:
//   1. Build a search URL with `keywords`, `location`, and a posted-within
//      filter that maps SearchFilters.postedWithinMin → LinkedIn's
//      `f_TPR=r<seconds>` parameter (their "Past 24 hours" filter is
//      `r86400`, etc.).
//   2. Sort by date posted (newest first) — `sortBy=DD`.
//   3. Iterate cards on the current page, parse, yield. Scroll for lazy
//      loading. Click "next page" when the page is exhausted.
//   4. Stop when we hit the cap or run out of pages.

import type { AdapterContext, DiscoveredJob } from '@apex/automation-core';
import { Domain } from '@apex/shared-types';
import { LINKEDIN_JOBS_SEARCH_URL, SEARCH_NEXT_PAGE_BUTTON, SEARCH_RESULTS_LIST } from '../selectors.js';
import { peekLayered, resolveAllLayered, scrollSearchPage, checkCancellation } from '@apex/automation-core';
import { parseListingCard } from './parse-listing.js';
import { ADAPTER_VERSION } from '../version.js';

export async function* searchLinkedIn(
  ctx: AdapterContext,
  filters: Domain.SearchFilters,
): AsyncIterable<DiscoveredJob> {
  const url = buildSearchUrl(filters);
  ctx.logger.info({ url, filters }, 'linkedin:search start');
  await ctx.pace('navigate');
  await ctx.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  let yielded = 0;
  const seen = new Set<string>();

  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    checkCancellation(ctx.cancellation);
    // Scroll the results to trigger lazy-load up to a max of `maxListings`.
    await scrollSearchPage(
      ctx.page,
      ctx.random,
      async () => {
        const cards = ctx.page.locator(SEARCH_RESULTS_LIST.layers[0]?.selector ?? '');
        return (await cards.count()) >= filters.maxListings;
      },
      30,
    );

    let cardLocator;
    try {
      cardLocator = await resolveAllLayered(ctx.page, SEARCH_RESULTS_LIST, {
        platformKey: 'linkedin',
        adapterVersion: ADAPTER_VERSION,
      });
    } catch {
      ctx.logger.info({ pageNumber }, 'linkedin:search no results on page');
      return;
    }
    const total = await cardLocator.count();
    for (let i = 0; i < total; i++) {
      checkCancellation(ctx.cancellation);
      if (yielded >= filters.maxListings) return;
      const card = cardLocator.nth(i);
      const parsed = await parseListingCard({ card, now: ctx.now });
      if (!parsed) continue;
      if (seen.has(parsed.externalId)) continue;
      seen.add(parsed.externalId);
      yielded++;
      yield parsed;
    }

    // Try to advance to the next page.
    const next = await peekLayered(ctx.page, SEARCH_NEXT_PAGE_BUTTON, 1_000);
    if (!next) {
      ctx.logger.info({ yielded }, 'linkedin:search no more pages');
      return;
    }
    await ctx.pace('click');
    try {
      await next.click({ timeout: 5_000 });
      await ctx.page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
    } catch (err) {
      ctx.logger.warn({ err }, 'linkedin:search next-page click failed; stopping');
      return;
    }
  }
}

/**
 * LinkedIn date filter: f_TPR=r<seconds-since-posting>. Map our
 * postedWithinMin to the closest documented value:
 *   <= 60   → r3600  (last hour, but LinkedIn uses 24h granularity in many surfaces)
 *   <= 1440 → r86400 (24 hours)
 *   <= 10080 → r604800 (1 week)
 *   else    → no filter
 */
function buildSearchUrl(filters: Domain.SearchFilters): string {
  const url = new URL(LINKEDIN_JOBS_SEARCH_URL);
  url.searchParams.set('keywords', filters.query);
  if (filters.locations.length > 0) {
    url.searchParams.set('location', filters.locations[0]!);
  }
  // Sort by date posted (newest first) — keeps freshness ranking achievable.
  url.searchParams.set('sortBy', 'DD');
  // Posted-within filter.
  const m = filters.postedWithinMin;
  if (m <= 60) url.searchParams.set('f_TPR', 'r3600');
  else if (m <= 1440) url.searchParams.set('f_TPR', 'r86400');
  else if (m <= 10_080) url.searchParams.set('f_TPR', 'r604800');
  // Remote / hybrid / onsite filter.
  if (filters.remoteKinds.length > 0) {
    const codes = filters.remoteKinds
      .map((k) => (k === 'remote' ? '2' : k === 'hybrid' ? '3' : k === 'onsite' ? '1' : ''))
      .filter((c) => c.length > 0)
      .join(',');
    if (codes.length > 0) url.searchParams.set('f_WT', codes);
  }
  return url.toString();
}
