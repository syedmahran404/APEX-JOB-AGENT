// BasePlatformAdapter — abstract base class platform adapters extend.
//
// Provides ergonomic helpers so adapter code stays focused on platform-
// specific selectors and flows:
//
//   - withStep()       Wraps a flow step in start/fail event emission +
//                      cancellation check + screenshot-on-throw.
//   - humanDelay()     Realistic delay before the next interaction.
//   - resolveSelector() Layered selector resolution + drift error.
//   - peekSelector()   Best-effort presence check (no exception).
//   - retryable()      Helper to bound retries on a sub-step.
//   - emitFieldFilled() Redacts the value before emission.

import type { Locator, Page } from 'playwright';
import type {
  PlatformAdapter,
  AdapterContext,
  PlatformKey,
  AdapterCaps,
} from '../types/adapter.js';
import type {
  DiscoveredJob,
  JobDetail,
  ApplyEligibility,
  ApplicationPlan,
  SubmitResult,
} from '../types/discovery.js';
import type { Domain } from '@apex/shared-types';
import type { ApplyEvent } from '@apex/shared-events';
import { CancellationError } from '../types/errors.js';
import { sleep, sampleGaussian, checkCancellation } from '../utils/delay.js';
import { redactValue } from '../utils/redaction.js';
import {
  type LayeredSelector,
  resolveLayered,
  peekLayered,
  resolveAllLayered,
} from '../selectors/helpers.js';

/** Per-action delay distributions. Tuned for "human-like, not human-pretending". */
const DELAY_DISTRIBUTIONS: Record<
  'navigate' | 'click' | 'type' | 'scroll' | 'submit' | 'idle',
  { mean: number; stdev: number; min: number; max: number }
> = {
  navigate: { mean: 1200, stdev: 400, min: 400, max: 3000 },
  click:    { mean: 220,  stdev: 90,  min: 80,  max: 600 },
  type:     { mean: 65,   stdev: 25,  min: 25,  max: 220 },
  scroll:   { mean: 380,  stdev: 140, min: 120, max: 900 },
  submit:   { mean: 600,  stdev: 200, min: 250, max: 1500 },
  idle:     { mean: 500,  stdev: 200, min: 100, max: 1500 },
};

export abstract class BasePlatformAdapter implements PlatformAdapter {
  abstract readonly key: PlatformKey;
  abstract readonly version: string;
  abstract readonly capabilities: AdapterCaps;

  abstract ensureSession(ctx: AdapterContext): Promise<void>;
  abstract search(ctx: AdapterContext, filters: Domain.SearchFilters): AsyncIterable<DiscoveredJob>;
  abstract parseJob(ctx: AdapterContext, jobUrl: string): Promise<JobDetail>;
  abstract canApply(ctx: AdapterContext, job: JobDetail): Promise<ApplyEligibility>;
  abstract apply(ctx: AdapterContext, job: JobDetail, plan: ApplicationPlan): Promise<SubmitResult>;

  /**
   * Wrap a flow step in `step.started` / `step.failed` event emission and a
   * cancellation check at the boundary.
   */
  protected async withStep<T>(
    ctx: AdapterContext,
    step: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    checkCancellation(ctx.cancellation);
    if (ctx.applicationId) {
      ctx.emit({ kind: 'step.started', applicationId: ctx.applicationId, step });
    }
    try {
      return await fn();
    } catch (err) {
      if (ctx.applicationId) {
        ctx.emit({
          kind: 'step.failed',
          applicationId: ctx.applicationId,
          step,
          reason: (err as Error).message,
          recoverable: this.isRecoverable(err),
        });
      }
      throw err;
    }
  }

  /**
   * Resolve a layered selector. Throws SelectorDriftError on miss; the
   * worker will turn that into a `failed_selector_drift` outcome with a
   * captured screenshot + DOM snapshot.
   */
  protected async resolveSelector(
    ctx: AdapterContext,
    selector: LayeredSelector,
    opts: { totalTimeoutMs?: number } = {},
  ): Promise<Locator> {
    return resolveLayered(ctx.page, selector, {
      ...opts,
      platformKey: this.key,
      adapterVersion: this.version,
    });
  }

  /** Best-effort: returns the locator if present within the peek budget, or null. */
  protected async peekSelector(
    ctx: AdapterContext,
    selector: LayeredSelector,
    peekTimeoutMs?: number,
  ): Promise<Locator | null> {
    return peekLayered(ctx.page, selector, peekTimeoutMs);
  }

  /** Resolve a list-style selector. Throws on miss. */
  protected async resolveAll(
    ctx: AdapterContext,
    selector: LayeredSelector,
    opts: { totalTimeoutMs?: number } = {},
  ): Promise<Locator> {
    return resolveAllLayered(ctx.page, selector, {
      ...opts,
      platformKey: this.key,
      adapterVersion: this.version,
    });
  }

  /** Realistic delay before the next interaction. Gaussian, clamped. */
  protected async humanDelay(
    ctx: AdapterContext,
    action: 'navigate' | 'click' | 'type' | 'scroll' | 'submit' | 'idle' = 'idle',
  ): Promise<void> {
    const dist = DELAY_DISTRIBUTIONS[action];
    const ms = sampleGaussian(ctx.random, dist.mean, dist.stdev, dist.min, dist.max);
    await sleep(ms, ctx.cancellation);
  }

  /** Type into a locator with per-character delays drawn from the `type` distribution. */
  protected async typeLikeHuman(
    ctx: AdapterContext,
    locator: Locator,
    text: string,
  ): Promise<void> {
    const dist = DELAY_DISTRIBUTIONS.type;
    await locator.click({ delay: 30 });
    for (const ch of text) {
      checkCancellation(ctx.cancellation);
      const delay = sampleGaussian(ctx.random, dist.mean, dist.stdev, dist.min, dist.max);
      await locator.type(ch, { delay });
    }
  }

  /**
   * For long fields, paste-and-tail: paste the bulk, then type one char to
   * leave a real key event (audit fix C3 — paste-vs-type heuristic).
   */
  protected async pasteWithTail(
    ctx: AdapterContext,
    locator: Locator,
    text: string,
  ): Promise<void> {
    if (text.length === 0) return;
    const head = text.slice(0, -1);
    const tail = text.slice(-1);
    await locator.click({ delay: 30 });
    if (head.length > 0) {
      // Use fill() for paste-equivalent (no per-char keypress).
      await locator.fill(head);
    }
    await this.humanDelay(ctx, 'idle');
    await locator.press('End');
    await locator.type(tail, { delay: 50 });
  }

  /**
   * Emit a `field.filled` event with redacted value. Adapter authors call
   * this after every input mutation so the timeline reflects field-level
   * activity.
   */
  protected emitFieldFilled(
    ctx: AdapterContext,
    field: string,
    value: string,
    source: ApplyEvent extends { kind: 'field.filled'; source: infer S } ? S : never,
  ): void {
    if (!ctx.applicationId) return;
    ctx.emit({
      kind: 'field.filled',
      applicationId: ctx.applicationId,
      field,
      valueRedacted: redactValue(field, value),
      source,
    });
  }

  /** Bounded retry helper for transient sub-steps within a flow. */
  protected async retryable<T>(
    ctx: AdapterContext,
    name: string,
    fn: () => Promise<T>,
    opts: { attempts?: number; baseMs?: number } = {},
  ): Promise<T> {
    const attempts = opts.attempts ?? 3;
    const baseMs = opts.baseMs ?? 200;
    let lastErr: unknown = null;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        checkCancellation(ctx.cancellation);
        if (!this.isRecoverable(err)) throw err;
        const backoff = baseMs * 2 ** i + Math.floor(ctx.random() * baseMs);
        ctx.logger.warn({ step: name, attempt: i + 1, err: (err as Error).message }, 'retryable step failed');
        await sleep(backoff, ctx.cancellation);
      }
    }
    throw lastErr;
  }

  /** Heuristic: is the error worth retrying? Override in subclasses if needed. */
  protected isRecoverable(err: unknown): boolean {
    if (err instanceof CancellationError) return false;
    if (typeof err === 'object' && err !== null) {
      const e = err as { code?: string };
      if (
        e.code === 'precondition_failed' || // human required, recon pending — not recoverable here
        e.code === 'forbidden' ||
        e.code === 'unauthenticated'
      ) {
        return false;
      }
    }
    return true;
  }

  /** Convenience: wait for the page to settle (network idle or short fallback). */
  protected async waitForPageSettle(page: Page, ms = 1500): Promise<void> {
    try {
      await page.waitForLoadState('networkidle', { timeout: ms });
    } catch {
      await page.waitForTimeout(Math.min(ms, 750));
    }
  }
}
