// ApplyRunner — orchestrates a single apply task end to end:
//   1. duplicate guard (recovery skip-sets + idempotency),
//   2. parse the job detail,
//   3. eligibility check,
//   4. drive the apply flow, streaming ApplyEvents to the reporter,
//   5. capture submission/failure screenshots,
//   6. on error, classify via the failure taxonomy and decide retry vs terminal.
//
// All collaborators are injected (adapter runtime, reporter, screenshots, guard),
// so the runner is fully unit-testable with the FakeBrowserDriver / fakes.
//
// Reference: docs/architecture/06-automation-engine.md §7, §14; recovery.ts.

import {
  classifyFailure,
  shouldRetry,
  isTerminalEvent,
  mayApply,
  type ApplyEvent,
  type ApplicationPlan,
  type JobDetail,
  type ResumePlan,
} from '@apex/automation-core';
import type { LinkedInRuntimeAdapter, AnswerProvider } from '../adapters/linkedin-runtime.js';
import type { ScreenshotCapturer } from '../reporting/screenshots.js';
import type { DriverPage } from '../browser/driver.js';

/** Persists ApplyEvents (→ application_events) and final application status. */
export interface ApplyReporter {
  emit(applicationId: string, event: ApplyEvent): Promise<void>;
  finalize(applicationId: string, outcome: 'submitted' | 'failed' | 'skipped' | 'human_required'): Promise<void>;
}

export interface ApplyRunnerDeps {
  adapter: LinkedInRuntimeAdapter;
  reporter: ApplyReporter;
  screenshots: ScreenshotCapturer;
  page: DriverPage;
  answer: AnswerProvider;
  clock: () => Date;
}

export interface ApplyRunInput {
  applicationId: string;
  runId: string;
  userId: string;
  platformKey: string;
  jobUrl: string;
  jobExternalId: string;
  canonicalKey: string;
  plan: ApplicationPlan;
  attempt: number;
  dryRun: boolean;
  /** Recovery skip-sets so we never re-apply to an already-applied job. */
  resume: Pick<ResumePlan, 'skipExternalIds' | 'skipCanonicalKeys'>;
}

export type ApplyResult =
  | { status: 'submitted'; externalApplicationId?: string | undefined }
  | { status: 'skipped'; reason: string }
  | { status: 'human_required'; reason: string }
  | { status: 'failed'; reason: string; retryable: boolean };

export class ApplyRunner {
  private seq = 0;

  constructor(private readonly deps: ApplyRunnerDeps) {}

  async run(input: ApplyRunInput): Promise<ApplyResult> {
    // 1. Duplicate guard (defense in depth alongside the DB partial-unique index).
    const guard = mayApply({ jobExternalId: input.jobExternalId, canonicalKey: input.canonicalKey }, input.resume);
    if (!guard.allowed) {
      await this.deps.reporter.finalize(input.applicationId, 'skipped');
      return { status: 'skipped', reason: guard.reason ?? 'duplicate' };
    }

    try {
      // 2. Parse the job detail.
      const job: JobDetail = await this.deps.adapter.parseJobDetail(input.jobUrl);

      // 3. Eligibility.
      const eligibility = await this.deps.adapter.canApply(job);
      if (eligibility.kind === 'already_applied') {
        await this.deps.reporter.finalize(input.applicationId, 'skipped');
        return { status: 'skipped', reason: 'already_applied' };
      }
      if (eligibility.kind === 'closed') {
        await this.deps.reporter.finalize(input.applicationId, 'skipped');
        return { status: 'skipped', reason: 'closed' };
      }
      if (eligibility.kind === 'external_redirect') {
        await this.deps.reporter.finalize(input.applicationId, 'skipped');
        return { status: 'skipped', reason: 'external_redirect' };
      }

      // 4. Drive the apply flow, streaming events.
      const result = await this.drive(input, job);
      return result;
    } catch (err) {
      // 6. Classify + decide retry vs terminal; capture a failure screenshot.
      return this.handleError(input, err);
    }
  }

  private async drive(input: ApplyRunInput, job: JobDetail): Promise<ApplyResult> {
    let humanReason: string | null = null;
    for await (const event of this.deps.adapter.applyEasy(job, input.plan, this.deps.answer)) {
      await this.deps.reporter.emit(input.applicationId, event);

      if (event.kind === 'human-required') {
        humanReason = event.reason;
        await this.captureScreenshot(input, 'failure', `human-required-${event.reason}`);
      }
      if (event.kind === 'captcha.detected') {
        humanReason = 'captcha';
        await this.captureScreenshot(input, 'captcha', 'captcha-detected');
      }
      if (event.kind === 'submitted') {
        // In dry-run the adapter still streams through; we record but do not
        // treat a dry-run submit as a real submission.
        await this.captureScreenshot(input, 'submission', 'submitted');
        if (input.dryRun) {
          await this.deps.reporter.finalize(input.applicationId, 'skipped');
          return { status: 'skipped', reason: 'dry_run' };
        }
        await this.deps.reporter.finalize(input.applicationId, 'submitted');
        return {
          status: 'submitted',
          externalApplicationId: event.externalApplicationId,
        };
      }
      if (event.kind === 'step.failed' && !event.recoverable) {
        await this.captureScreenshot(input, 'failure', `step-failed-${event.step}`);
        await this.deps.reporter.finalize(input.applicationId, 'failed');
        return { status: 'failed', reason: event.reason, retryable: false };
      }
      if (isTerminalEvent(event) && event.kind === 'human-required') {
        await this.deps.reporter.finalize(input.applicationId, 'human_required');
        return { status: 'human_required', reason: humanReason ?? 'human-required' };
      }
    }
    // Stream ended without a terminal submit/fail → treat as failed (incomplete).
    await this.deps.reporter.finalize(input.applicationId, 'failed');
    return { status: 'failed', reason: 'apply-stream-incomplete', retryable: true };
  }

  private async handleError(input: ApplyRunInput, err: unknown): Promise<ApplyResult> {
    const message = err instanceof Error ? err.message : String(err);
    const classified = classifyFailure({ message });
    await this.captureScreenshot(input, 'exception', `exception-${classified.class}`).catch(() => undefined);
    const retryable = classified.recoverable && shouldRetry(classified, input.attempt);
    await this.deps.reporter.finalize(input.applicationId, 'failed');
    return { status: 'failed', reason: `${classified.class}: ${message}`, retryable };
  }

  private async captureScreenshot(
    input: ApplyRunInput,
    reason: 'failure' | 'submission' | 'exception' | 'captcha',
    label: string,
  ): Promise<void> {
    const meta = await this.deps.screenshots.capture({
      page: this.deps.page,
      reason,
      runId: input.runId,
      userId: input.userId,
      platformKey: input.platformKey,
      applicationId: input.applicationId,
      label,
      seq: this.seq++,
    });
    await this.deps.reporter.emit(input.applicationId, {
      kind: 'screenshot',
      uri: meta.storageKey,
      label,
    });
  }
}
