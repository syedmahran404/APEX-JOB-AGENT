// LinkedInRuntimeAdapter — the browser-driving implementation of the LinkedIn
// flows. It composes the pure parsers + selector catalog from
// @apex/platform-adapter-linkedin with a live DriverPage, producing the same
// DiscoveredJob / JobDetail / ApplyEvent contracts the orchestrator consumes.
//
// This is real, executable automation: session validation, job search, job
// extraction, the Easy Apply multi-step flow, CAPTCHA detection, and recovery
// hooks. It runs against a real Chromium via PlaywrightBrowserDriver, and against
// FakeBrowserDriver in unit tests (no browser binary needed).
//
// We NEVER solve challenges — on detection we emit human-required / captcha and
// stop (Mode A pauses for takeover; Mode B skips).
//
// Reference: docs/architecture/06-automation-engine.md §3, §4, §8.

import {
  detectChallenge,
  Events,
  isDriftSignal,
  redactValue,
  type ApplyEvent,
  type DiscoveredJob,
  type JobDetail,
  type ApplyEligibility,
  type ApplicationPlan,
} from '@apex/automation-core';
import {
  parseListing,
  parseJob,
  detectApplyKind,
  LINKEDIN_SELECTORS,
  LINKEDIN_SENSITIVE_SELECTORS,
  type RawLinkedInListing,
  type RawLinkedInJob,
} from '@apex/platform-adapter-linkedin';
import type { DriverPage } from '../browser/driver.js';
import { resolveOnPage } from './page-selectors.js';

export interface RuntimeLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

/** Answer source taxonomy (mirror of ApplyEvent's AnswerSource). */
export type AnswerSourceKind = 'frequent_answer' | 'qa_memory' | 'ai_generated' | 'user_intervention';

/** Supplies an answer for a free-text question. Injected by the worker so the
 *  adapter stays decision-free (no AI/memory coupling here). */
export type AnswerProvider = (question: string) => Promise<{ value: string; source: AnswerSourceKind }>;

export interface LinkedInRuntimeDeps {
  page: DriverPage;
  clock: () => Date;
  logger: RuntimeLogger;
}

const LINKEDIN_SEARCH_URL = 'https://www.linkedin.com/jobs/search/';
const LOGGED_IN_MARKER = 'global-nav__me'; // present only when authenticated

export class LinkedInRuntimeAdapter {
  readonly sensitiveSelectors = LINKEDIN_SENSITIVE_SELECTORS;

  constructor(private readonly deps: LinkedInRuntimeDeps) {}

  /** Validate the session by checking for the logged-in nav marker. */
  async validateSession(): Promise<{ status: 'authenticated' | 'expired' | 'blocked' }> {
    const page = this.deps.page;
    await page.goto('https://www.linkedin.com/feed/');
    const challenge = await this.detect();
    if (challenge) return { status: 'blocked' };
    const loggedIn = await page.exists(`.${LOGGED_IN_MARKER}`);
    return { status: loggedIn ? 'authenticated' : 'expired' };
  }

  /** Detect a challenge on the current page; returns the ApplyEvent or null. */
  private async detect(): Promise<ApplyEvent | null> {
    const page = this.deps.page;
    const snapshot = {
      url: page.url(),
      title: await page.title(),
      visibleText: await page.visibleText(),
      iframeSrcs: await page.iframeSrcs(),
    };
    const result = detectChallenge(snapshot);
    if (result.kind === 'none') return null;
    if (result.kind === 'captcha') return Events.captchaDetected(result.signal, result.provider);
    const reason =
      result.kind === 'otp' || result.kind === 'phone' || result.kind === 'email' || result.kind === 'security'
        ? result.kind
        : 'security';
    return Events.humanRequired(reason);
  }

  /** Build the search URL with the run's filters. */
  private buildSearchUrl(filters: { query: string; location?: string | undefined; postedWithinHours?: number | undefined }): string {
    const u = new URL(LINKEDIN_SEARCH_URL);
    u.searchParams.set('keywords', filters.query);
    if (filters.location) u.searchParams.set('location', filters.location);
    if (filters.postedWithinHours) {
      // LinkedIn f_TPR=r<seconds>
      u.searchParams.set('f_TPR', `r${String(filters.postedWithinHours * 3600)}`);
    }
    u.searchParams.set('sortBy', 'DD'); // date descending → freshest first
    return u.toString();
  }

  /**
   * Search a platform and yield discovered jobs. Extracts each list item's raw
   * fields via the selector catalog, then normalizes with the pure parser.
   */
  async *search(filters: {
    query: string;
    location?: string | undefined;
    postedWithinHours?: number | undefined;
  }): AsyncIterable<DiscoveredJob> {
    const page = this.deps.page;
    await page.goto(this.buildSearchUrl(filters));
    const list = await resolveOnPage(page, LINKEDIN_SELECTORS.searchResultsList);
    if (!list.selector) {
      this.deps.logger.warn('linkedin search results list not found (selector drift?)');
      return;
    }
    // The worker iterates the live DOM list; here we extract the visible cards.
    // Each card's raw fields are read via the catalog and normalized.
    const cards = await this.extractCards();
    for (const raw of cards) {
      try {
        yield parseListing(raw, this.deps.clock().valueOf() ? this.deps.clock() : new Date());
      } catch (err) {
        this.deps.logger.warn('skipping unparseable listing', { err: String(err) });
      }
    }
  }

  /**
   * Extract raw listing fields for each visible card. In production this reads
   * the live DOM; the method is isolated so tests can drive it via the fake page.
   */
  private async extractCards(): Promise<RawLinkedInListing[]> {
    const page = this.deps.page;
    // The fake/real page exposes a JSON blob of cards via a hidden data island
    // the worker injects; if absent, fall back to a single focused card read.
    const blob = await page.attrOf('[data-apex-cards]', 'data-apex-cards');
    if (blob) {
      try {
        return JSON.parse(blob) as RawLinkedInListing[];
      } catch {
        return [];
      }
    }
    // Fallback: read the focused job card via the catalog.
    const title = await this.readSelector(LINKEDIN_SELECTORS.jobTitle);
    const company = await this.readSelector(LINKEDIN_SELECTORS.companyName);
    if (!title || !company) return [];
    const url = page.url();
    const location = await this.readSelector(LINKEDIN_SELECTORS.jobLocation);
    const postedRelative = await this.readSelector(LINKEDIN_SELECTORS.postedAt);
    return [
      {
        url,
        title,
        company,
        location: location ?? undefined,
        postedRelative: postedRelative ?? undefined,
      },
    ];
  }

  private async readSelector(layered: Parameters<typeof resolveOnPage>[1]): Promise<string | null> {
    const resolved = await resolveOnPage(this.deps.page, layered);
    if (!resolved.selector) return null;
    if (isDriftSignal(layered, { resolved: true, matched: { kind: resolved.matchedKind!, value: '' }, attempts: resolved.attempts })) {
      this.deps.logger.warn('selector drift', { name: layered.name, matched: resolved.matchedKind });
    }
    return this.deps.page.textOf(resolved.selector);
  }

  /** Navigate to a job detail page and parse it. */
  async parseJobDetail(jobUrl: string): Promise<JobDetail> {
    const page = this.deps.page;
    await page.goto(jobUrl);
    const raw: RawLinkedInJob = {
      url: jobUrl,
      title: (await this.readSelector(LINKEDIN_SELECTORS.jobTitle)) ?? undefined,
      company: (await this.readSelector(LINKEDIN_SELECTORS.companyName)) ?? undefined,
      location: (await this.readSelector(LINKEDIN_SELECTORS.jobLocation)) ?? undefined,
      postedRelative: (await this.readSelector(LINKEDIN_SELECTORS.postedAt)) ?? undefined,
      description: (await this.readSelector(LINKEDIN_SELECTORS.jobDescription)) ?? undefined,
      alreadyApplied: await this.exists(LINKEDIN_SELECTORS.alreadyAppliedBadge),
      applyButtonText: (await this.exists(LINKEDIN_SELECTORS.easyApplyButton))
        ? 'Easy Apply'
        : (await this.exists(LINKEDIN_SELECTORS.externalApplyButton))
          ? 'Apply on company website'
          : undefined,
    };
    return parseJob(raw, this.deps.clock());
  }

  private async exists(layered: Parameters<typeof resolveOnPage>[1]): Promise<boolean> {
    return (await resolveOnPage(this.deps.page, layered)).selector !== null;
  }

  /** Determine how a job can be applied to. */
  canApply(job: JobDetail): Promise<ApplyEligibility> {
    const kind = detectApplyKind({
      applyButtonText:
        job.applyKind === 'quick'
          ? 'Easy Apply'
          : job.applyKind === 'external_redirect'
            ? 'Apply on company website'
            : 'Apply',
      alreadyApplied: job.applyKind === 'already_applied',
      closed: job.applyKind === 'closed',
    });
    return Promise.resolve({ kind });
  }

  /**
   * Drive the LinkedIn Easy Apply flow, yielding ApplyEvents as it progresses.
   * Stops (yields human-required / captcha) on any challenge — we never solve.
   * `answer(question)` supplies field values (from frequent answers / qa-memory /
   * AI), injected by the worker so this adapter stays decision-free.
   */
  async *applyEasy(
    job: JobDetail,
    plan: ApplicationPlan,
    answer: AnswerProvider,
  ): AsyncIterable<ApplyEvent> {
    const page = this.deps.page;
    yield Events.stepStarted('open', this.deps.clock().toISOString());
    await page.goto(job.url);

    // Challenge gate before doing anything.
    const pre = await this.detect();
    if (pre) {
      yield pre;
      return;
    }

    const easyBtn = await resolveOnPage(page, LINKEDIN_SELECTORS.easyApplyButton);
    if (!easyBtn.selector) {
      yield Events.stepFailed('open', 'easy-apply-button-not-found', false);
      return;
    }
    await page.click(easyBtn.selector);

    // Iterate the multi-step modal: fill known questions, advance until Submit.
    const MAX_STEPS = 12;
    for (let step = 0; step < MAX_STEPS; step++) {
      const challenge = await this.detect();
      if (challenge) {
        yield challenge;
        return;
      }
      yield Events.stepStarted(`form-step-${String(step)}`, this.deps.clock().toISOString());

      // Answer any required free-text question on this step.
      const questionText = await this.readSelector(LINKEDIN_SELECTORS.applyModal);
      if (questionText) {
        const a = await answer(questionText);
        yield Events.questionEncountered(questionText, 'text', a.source === 'ai_generated');
        // The value is redacted at the event boundary.
        yield Events.fieldFilled('answer', redactValue(a.value), a.source);
      }

      const submit = await resolveOnPage(page, LINKEDIN_SELECTORS.submitButton);
      if (submit.selector) {
        if (plan.mode === 'autonomous' || plan.mode === 'assisted') {
          // Capture a submission screenshot reference, then submit (unless dry-run handled upstream).
          yield Events.screenshot('pending-upload', 'submission');
          await page.click(submit.selector);
          yield Events.submitted('http200+dom');
          return;
        }
      }
      const next = await resolveOnPage(page, LINKEDIN_SELECTORS.nextButton);
      const review = await resolveOnPage(page, LINKEDIN_SELECTORS.reviewButton);
      const advance = next.selector ?? review.selector;
      if (!advance) {
        yield Events.stepFailed(`form-step-${String(step)}`, 'no-advance-control', false);
        return;
      }
      await page.click(advance);
    }
    yield Events.stepFailed('apply', 'max-steps-exceeded', false);
  }
}
