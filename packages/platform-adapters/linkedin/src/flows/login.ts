// LinkedIn login flow.
//
// Triggered ONLY when ensureSession determines the storage state is missing
// or stale. The credentials come from a Vault lease redemption — the worker
// hands them in as a sealed object that this flow consumes once and wipes.
//
// Detection paths:
//   - successful login → header.global-nav appears (LOGGED_IN_INDICATOR)
//   - bad credentials → LOGIN_ERROR_BANNER appears
//   - human required → CAPTCHA / OTP pattern detected by engine layer

import type { AdapterContext } from '@apex/automation-core';
import { HumanRequiredError, AccountBlockedError } from '@apex/automation-core';
import {
  LINKEDIN_LOGIN_URL,
  LOGIN_USERNAME_INPUT,
  LOGIN_PASSWORD_INPUT,
  LOGIN_SUBMIT_BUTTON,
  LOGIN_ERROR_BANNER,
  LOGGED_IN_INDICATOR,
} from '../selectors.js';
import { resolveLayered, peekLayered } from '@apex/automation-core';
import { ADAPTER_VERSION } from '../version.js';

export interface LinkedInCredentials {
  username: string;
  password: string;
}

export async function performLogin(
  ctx: AdapterContext,
  credentials: LinkedInCredentials,
): Promise<void> {
  ctx.logger.info('linkedin:login starting');

  // Pace the navigation.
  await ctx.pace('navigate');
  await ctx.page.goto(LINKEDIN_LOGIN_URL, { waitUntil: 'domcontentloaded' });

  // Already logged in? Nothing to do.
  const already = await peekLayered(ctx.page, LOGGED_IN_INDICATOR, 1_500);
  if (already) {
    ctx.logger.info('linkedin:login already authenticated');
    return;
  }

  const usernameLoc = await resolveLayered(ctx.page, LOGIN_USERNAME_INPUT, {
    platformKey: 'linkedin',
    adapterVersion: ADAPTER_VERSION,
    totalTimeoutMs: 8_000,
  });
  await usernameLoc.fill('');
  await usernameLoc.type(credentials.username, { delay: 60 });

  const passwordLoc = await resolveLayered(ctx.page, LOGIN_PASSWORD_INPUT, {
    platformKey: 'linkedin',
    adapterVersion: ADAPTER_VERSION,
    totalTimeoutMs: 4_000,
  });
  await passwordLoc.fill('');
  await passwordLoc.type(credentials.password, { delay: 50 });

  await ctx.pace('submit');
  const submitLoc = await resolveLayered(ctx.page, LOGIN_SUBMIT_BUTTON, {
    platformKey: 'linkedin',
    adapterVersion: ADAPTER_VERSION,
    totalTimeoutMs: 4_000,
  });
  await submitLoc.click();

  // Wait for one of: success, error banner, or human-required.
  await Promise.race([
    ctx.page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined),
    ctx.page.waitForURL(/\/feed/i, { timeout: 15_000 }).catch(() => undefined),
  ]);

  const success = await peekLayered(ctx.page, LOGGED_IN_INDICATOR, 2_000);
  if (success) {
    ctx.logger.info('linkedin:login succeeded');
    return;
  }
  const error = await peekLayered(ctx.page, LOGIN_ERROR_BANNER, 1_500);
  if (error) {
    const text = (await error.textContent({ timeout: 500 }))?.toLowerCase() ?? '';
    ctx.logger.warn({ text }, 'linkedin:login banner');
    if (/incorrect|invalid|wrong/.test(text)) {
      throw new AccountBlockedError('linkedin', 'invalid_credentials');
    }
    if (/too many|verify|verification/.test(text)) {
      throw new HumanRequiredError('security', text);
    }
    throw new AccountBlockedError('linkedin', text || 'login_error');
  }

  // No success and no error banner — assume challenge / checkpoint screen.
  // The engine's CaptchaDetectionManager will identify the kind.
  throw new HumanRequiredError('security', 'login_challenge_or_checkpoint');
}
