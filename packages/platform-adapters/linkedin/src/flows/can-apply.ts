// can-apply — given a parsed JobDetail, determine the apply path before
// opening the form.

import type { AdapterContext, ApplyEligibility, JobDetail } from '@apex/automation-core';
import { peekLayered, detectAtsByUrl } from '@apex/automation-core';
import {
  APPLIED_INDICATOR,
  APPLY_BUTTON_GENERIC,
  EASY_APPLY_BUTTON,
} from '../selectors.js';

export async function canApplyLinkedIn(ctx: AdapterContext, _job: JobDetail): Promise<ApplyEligibility> {
  void _job;
  // 1. Already applied?
  const applied = await peekLayered(ctx.page, APPLIED_INDICATOR, 500);
  if (applied) {
    return { kind: 'already_applied' };
  }

  // 2. Easy Apply path?
  const easyApply = await peekLayered(ctx.page, EASY_APPLY_BUTTON, 1_200);
  if (easyApply) {
    return { kind: 'quick' };
  }

  // 3. Generic apply that links out to an ATS?
  const generic = await peekLayered(ctx.page, APPLY_BUTTON_GENERIC, 1_200);
  if (generic) {
    const href = (await generic.getAttribute('href', { timeout: 250 })) ?? '';
    if (href.length > 0) {
      const ats = detectAtsByUrl(href);
      if (ats !== 'unknown') return { kind: 'external_redirect', ats };
      // It's an external link but not a recognized ATS — treat as unsupported.
      return { kind: 'external_redirect', ats: 'unknown' };
    }
    // Generic button without an href — likely a multi-step LinkedIn flow.
    return { kind: 'multi_step' };
  }

  // 4. No apply UI at all → closed.
  return { kind: 'closed' };
}
