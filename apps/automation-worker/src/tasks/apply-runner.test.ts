import { describe, it, expect } from 'vitest';
import {
  Events,
  type ApplyEvent,
  type ApplicationPlan,
  type ApplyEligibility,
  type JobDetail,
} from '@apex/automation-core';
import { ApplyRunner, type ApplyReporter, type ApplyRunInput } from './apply-runner.js';
import type { LinkedInRuntimeAdapter } from '../adapters/linkedin-runtime.js';
import type { ScreenshotCapturer } from '../reporting/screenshots.js';
import { FakePage } from '../browser/fake-driver.js';

const PLAN: ApplicationPlan = { applicationId: 'app-1', resumeVersionId: 'rv-1', allowAiAnswers: true, mode: 'autonomous' };

class FakeReporter implements ApplyReporter {
  events: ApplyEvent[] = [];
  finalOutcome: string | null = null;
  emit(_id: string, e: ApplyEvent): Promise<void> {
    this.events.push(e);
    return Promise.resolve();
  }
  finalize(_id: string, outcome: string): Promise<void> {
    this.finalOutcome = outcome;
    return Promise.resolve();
  }
}

/** A scriptable stand-in for the runtime adapter (we only need 3 methods). */
function fakeAdapter(opts: {
  applyKind?: ApplyEligibility['kind'];
  events?: ApplyEvent[];
  parseThrows?: string;
}): LinkedInRuntimeAdapter {
  const events = opts.events ?? [Events.submitted('http200+dom', 'ext-1')];
  return {
    parseJobDetail: (url: string): Promise<JobDetail> => {
      if (opts.parseThrows) return Promise.reject(new Error(opts.parseThrows));
      return Promise.resolve({
        externalId: '3856120947',
        platformKey: 'linkedin',
        title: 'Backend Engineer',
        company: 'Acme',
        url,
        postedAt: null,
        postedAtUncertain: true,
        description: 'desc',
        applyKind: opts.applyKind ?? 'quick',
      });
    },
    canApply: (): Promise<ApplyEligibility> => Promise.resolve({ kind: opts.applyKind ?? 'quick' }),
    // eslint-disable-next-line @typescript-eslint/require-await
    applyEasy: async function* (): AsyncIterable<ApplyEvent> {
      for (const e of events) yield e;
    },
  } as unknown as LinkedInRuntimeAdapter;
}

function fakeScreenshots(): ScreenshotCapturer {
  return {
    capture: () =>
      Promise.resolve({
        reason: 'failure',
        runId: 'r',
        platformKey: 'linkedin',
        label: 'l',
        capturedAt: '2026-06-02T12:00:00.000Z',
        storageKey: 'screenshots/u/r/0000-failure-linkedin.png',
        sensitiveSelectors: [],
      }),
  } as unknown as ScreenshotCapturer;
}

function baseInput(over: Partial<ApplyRunInput> = {}): ApplyRunInput {
  return {
    applicationId: 'app-1',
    runId: 'run-1',
    userId: 'u-1',
    platformKey: 'linkedin',
    jobUrl: 'https://www.linkedin.com/jobs/view/3856120947',
    jobExternalId: '3856120947',
    canonicalKey: 'key-1',
    plan: PLAN,
    attempt: 0,
    dryRun: false,
    resume: { skipExternalIds: new Set(), skipCanonicalKeys: new Set() },
    ...over,
  };
}

function makeRunner(adapter: LinkedInRuntimeAdapter) {
  const reporter = new FakeReporter();
  const runner = new ApplyRunner({
    adapter,
    reporter,
    screenshots: fakeScreenshots(),
    page: new FakePage(),
    answer: () => Promise.resolve({ value: 'Yes', source: 'frequent_answer' }),
    clock: () => new Date('2026-06-02T12:00:00.000Z'),
  });
  return { runner, reporter };
}

describe('ApplyRunner', () => {
  it('submits successfully and finalizes submitted', async () => {
    const { runner, reporter } = makeRunner(fakeAdapter({ events: [Events.submitted('http200+dom', 'ext-9')] }));
    const res = await runner.run(baseInput());
    expect(res.status).toBe('submitted');
    if (res.status === 'submitted') expect(res.externalApplicationId).toBe('ext-9');
    expect(reporter.finalOutcome).toBe('submitted');
  });

  it('skips when the job was already applied (recovery skip-set, external id)', async () => {
    const { runner, reporter } = makeRunner(fakeAdapter({}));
    const res = await runner.run(baseInput({ resume: { skipExternalIds: new Set(['3856120947']), skipCanonicalKeys: new Set() } }));
    expect(res.status).toBe('skipped');
    if (res.status === 'skipped') expect(res.reason).toBe('external_id_applied');
    expect(reporter.finalOutcome).toBe('skipped');
  });

  it('skips when the same role was applied on another platform (canonical key)', async () => {
    const { runner } = makeRunner(fakeAdapter({}));
    const res = await runner.run(baseInput({ resume: { skipExternalIds: new Set(), skipCanonicalKeys: new Set(['key-1']) } }));
    expect(res.status).toBe('skipped');
    if (res.status === 'skipped') expect(res.reason).toBe('canonical_applied');
  });

  it('skips an already_applied job detected on the page', async () => {
    const { runner } = makeRunner(fakeAdapter({ applyKind: 'already_applied' }));
    const res = await runner.run(baseInput());
    expect(res.status).toBe('skipped');
    if (res.status === 'skipped') expect(res.reason).toBe('already_applied');
  });

  it('skips an external_redirect job', async () => {
    const { runner } = makeRunner(fakeAdapter({ applyKind: 'external_redirect' }));
    const res = await runner.run(baseInput());
    expect(res.status).toBe('skipped');
    if (res.status === 'skipped') expect(res.reason).toBe('external_redirect');
  });

  it('returns human_required when the flow yields human-required', async () => {
    const { runner, reporter } = makeRunner(fakeAdapter({ events: [Events.humanRequired('otp')] }));
    const res = await runner.run(baseInput());
    expect(res.status).toBe('human_required');
    expect(reporter.finalOutcome).toBe('human_required');
  });

  it('treats dry-run submit as skipped (dry_run), not a real submission', async () => {
    const { runner, reporter } = makeRunner(fakeAdapter({ events: [Events.submitted('http200+dom')] }));
    const res = await runner.run(baseInput({ dryRun: true }));
    expect(res.status).toBe('skipped');
    if (res.status === 'skipped') expect(res.reason).toBe('dry_run');
    expect(reporter.finalOutcome).toBe('skipped');
  });

  it('classifies a thrown network error as retryable failure', async () => {
    const { runner } = makeRunner(fakeAdapter({ parseThrows: 'getaddrinfo ENOTFOUND linkedin.com' }));
    const res = await runner.run(baseInput());
    expect(res.status).toBe('failed');
    if (res.status === 'failed') expect(res.retryable).toBe(true);
  });

  it('classifies a flagged-account error as non-retryable failure', async () => {
    const { runner } = makeRunner(fakeAdapter({ parseThrows: 'account is flagged for unusual activity' }));
    const res = await runner.run(baseInput());
    expect(res.status).toBe('failed');
    if (res.status === 'failed') expect(res.retryable).toBe(false);
  });

  it('emits a screenshot event on submission', async () => {
    const { runner, reporter } = makeRunner(fakeAdapter({ events: [Events.submitted('http200+dom')] }));
    await runner.run(baseInput());
    expect(reporter.events.some((e) => e.kind === 'screenshot')).toBe(true);
  });
});
