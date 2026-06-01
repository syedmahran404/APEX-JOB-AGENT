// apply — Easy Apply flow.
//
// LinkedIn's Easy Apply modal has a few step archetypes:
//   1. "Contact info": prefilled from the user's profile; usually just a
//      phone number requiring confirmation.
//   2. "Resume": pick from existing or upload a new one.
//   3. "Additional questions": 0..N free-form / select / yes-no questions.
//   4. "Review": preview screen.
//   5. "Submit": single-click submit.
//
// We detect which step we're on by the visible button:
//   - "Continue to next step" → next
//   - "Review your application" → review
//   - "Submit application" → submit
// If neither is visible, we have a stuck / unrecognized step → human-required
// (fall through; engine handles per mode).

import type {
  AdapterContext,
  ApplicationPlan,
  JobDetail,
  SubmitResult,
} from '@apex/automation-core';
import {
  HumanRequiredError,
  peekLayered,
  resolveLayered,
} from '@apex/automation-core';
import {
  EASY_APPLY_BUTTON,
  EASY_APPLY_DISMISS_BUTTON,
  EASY_APPLY_DONE_BANNER,
  EASY_APPLY_MODAL,
  EASY_APPLY_NEXT_BUTTON,
  EASY_APPLY_QUESTION_GROUP,
  EASY_APPLY_REVIEW_BUTTON,
  EASY_APPLY_SUBMIT_BUTTON,
} from '../selectors.js';
import { ADAPTER_VERSION } from '../version.js';

const MAX_STEPS = 12;

export async function applyLinkedIn(
  ctx: AdapterContext,
  _job: JobDetail,
  plan: ApplicationPlan,
): Promise<SubmitResult> {
  void _job;
  // Open the Easy Apply modal.
  await ctx.pace('click');
  const trigger = await resolveLayered(ctx.page, EASY_APPLY_BUTTON, {
    platformKey: 'linkedin',
    adapterVersion: ADAPTER_VERSION,
    totalTimeoutMs: 6_000,
  });
  await trigger.click();
  await resolveLayered(ctx.page, EASY_APPLY_MODAL, {
    platformKey: 'linkedin',
    adapterVersion: ADAPTER_VERSION,
    totalTimeoutMs: 8_000,
  });
  if (ctx.applicationId) {
    ctx.emit({ kind: 'opened', applicationId: ctx.applicationId, url: ctx.page.url() });
    ctx.emit({ kind: 'step.started', applicationId: ctx.applicationId, step: 'easy-apply.open' });
  }

  // Step loop.
  for (let step = 0; step < MAX_STEPS; step++) {
    if (ctx.cancellation.aborted) {
      return { kind: 'failed', reason: 'cancelled', recoverable: false };
    }

    // Surface free-text/numeric questions to the engine for visibility.
    await emitVisibleQuestions(ctx);

    // Try Submit first (final step). If present and enabled, click it.
    const submit = await peekLayered(ctx.page, EASY_APPLY_SUBMIT_BUTTON, 600);
    if (submit) {
      const disabled = (await submit.getAttribute('disabled', { timeout: 200 })) !== null;
      if (disabled) {
        // Form is incomplete — adapter cannot finish without more info.
        // Surface as human-required so the engine handles per mode.
        ctx.logger.warn('linkedin:apply submit-disabled (form incomplete)');
        await dismissModal(ctx);
        if (plan.autonomous) {
          return { kind: 'skipped', reason: 'form_incomplete' };
        }
        throw new HumanRequiredError('security', 'easy_apply_form_incomplete');
      }
      if (plan.dryRun) {
        ctx.logger.info('linkedin:apply dry-run — not submitting');
        await dismissModal(ctx);
        return {
          kind: 'submitted',
          externalApplicationId: null,
          confirmation: 'dom-only',
          submittedAt: ctx.now(),
        };
      }
      await ctx.pace('submit');
      await submit.click();
      // Wait for confirmation.
      const done = await peekLayered(ctx.page, EASY_APPLY_DONE_BANNER, 8_000);
      if (done) {
        ctx.logger.info('linkedin:apply submitted (confirmation banner)');
        await dismissModal(ctx);
        return {
          kind: 'submitted',
          externalApplicationId: null,
          confirmation: 'dom-only',
          submittedAt: ctx.now(),
        };
      }
      // No banner — best-effort: assume success; the engine's reaper will
      // reconcile from `applications.status = submitting`.
      ctx.logger.warn('linkedin:apply no confirmation banner; assuming success');
      return {
        kind: 'submitted',
        externalApplicationId: null,
        confirmation: 'redirect-success',
        submittedAt: ctx.now(),
      };
    }

    // Try Review (penultimate step).
    const review = await peekLayered(ctx.page, EASY_APPLY_REVIEW_BUTTON, 400);
    if (review) {
      await ctx.pace('click');
      await review.click();
      continue;
    }

    // Try Next.
    const next = await peekLayered(ctx.page, EASY_APPLY_NEXT_BUTTON, 400);
    if (next) {
      const disabled = (await next.getAttribute('disabled', { timeout: 200 })) !== null;
      if (disabled) {
        // Required field unfilled. In Phase 2 we can't auto-fill arbitrary
        // questions (the AI engine + Q&A memory ship in Phase 3).
        ctx.logger.info('linkedin:apply next-disabled (required field unfilled)');
        await dismissModal(ctx);
        if (plan.autonomous) {
          return { kind: 'skipped', reason: 'required_field_unfilled' };
        }
        throw new HumanRequiredError('security', 'easy_apply_required_field');
      }
      await ctx.pace('click');
      await next.click();
      continue;
    }

    // Unknown step.
    ctx.logger.warn('linkedin:apply unknown step — bailing');
    await dismissModal(ctx);
    return { kind: 'failed', reason: 'unknown_step', recoverable: true };
  }

  // Loop exit (max steps).
  await dismissModal(ctx);
  return { kind: 'failed', reason: 'max_steps_exceeded', recoverable: true };
}

async function emitVisibleQuestions(ctx: AdapterContext): Promise<void> {
  if (!ctx.applicationId) return;
  const groups = await peekLayered(ctx.page, EASY_APPLY_QUESTION_GROUP, 200);
  if (!groups) return;
  try {
    const all = ctx.page.locator(EASY_APPLY_QUESTION_GROUP.layers[0]?.selector ?? '');
    const count = Math.min(await all.count(), 6);
    for (let i = 0; i < count; i++) {
      const el = all.nth(i);
      const labelEl = el.locator('label, legend, span.fb-form-element__label').first();
      const labelText = (await labelEl.textContent({ timeout: 250 }).catch(() => null)) ?? null;
      if (!labelText || labelText.trim().length === 0) continue;
      const fieldKind = await detectFieldKind(el);
      ctx.emit({
        kind: 'question.encountered',
        applicationId: ctx.applicationId,
        questionRaw: labelText.trim().slice(0, 512),
        fieldKind,
        expectsAi: false,
      });
    }
  } catch {
    // Diagnostic emission is best-effort.
  }
}

async function detectFieldKind(el: import('playwright').Locator): Promise<
  'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'file' | 'date' | 'number'
> {
  if ((await el.locator('textarea').count()) > 0) return 'textarea';
  if ((await el.locator('select').count()) > 0) return 'select';
  if ((await el.locator('input[type="radio"]').count()) > 0) return 'radio';
  if ((await el.locator('input[type="checkbox"]').count()) > 0) return 'checkbox';
  if ((await el.locator('input[type="file"]').count()) > 0) return 'file';
  if ((await el.locator('input[type="number"]').count()) > 0) return 'number';
  if ((await el.locator('input[type="date"]').count()) > 0) return 'date';
  return 'text';
}

async function dismissModal(ctx: AdapterContext): Promise<void> {
  const dismiss = await peekLayered(ctx.page, EASY_APPLY_DISMISS_BUTTON, 600);
  if (dismiss) {
    try {
      await dismiss.click({ timeout: 1_500 });
    } catch {
      /* ignore */
    }
  }
}
