// ensure-session — fast path for "are we logged in?".
//
// We avoid driving login from this function. Instead:
//   1. Navigate to the feed URL.
//   2. If the LOGGED_IN_INDICATOR resolves quickly, we're authenticated.
//   3. Otherwise, throw SessionExpiredError. The engine treats this as a
//      session-refresh cue and (in a later phase) invokes the lease+redeem
//      flow to drive `performLogin`. In Phase 2 the worker manually pre-
//      seeds storage state via the platform-account credential bundle on
//      first run; thereafter ensureSession should always succeed.

import type { AdapterContext } from '@apex/automation-core';
import { SessionExpiredError, peekLayered } from '@apex/automation-core';
import { LINKEDIN_FEED_URL, LOGGED_IN_INDICATOR } from '../selectors.js';

export async function ensureLinkedInSession(ctx: AdapterContext): Promise<void> {
  await ctx.pace('navigate');
  await ctx.page.goto(LINKEDIN_FEED_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const present = await peekLayered(ctx.page, LOGGED_IN_INDICATOR, 3_000);
  if (present) {
    ctx.logger.debug('linkedin:ensure-session OK');
    return;
  }
  // Not logged in.
  throw new SessionExpiredError('linkedin');
}
