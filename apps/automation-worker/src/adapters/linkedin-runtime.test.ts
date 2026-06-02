import { describe, it, expect } from 'vitest';
import type { ApplicationPlan, JobDetail } from '@apex/automation-core';
import { LinkedInRuntimeAdapter, type AnswerProvider } from './linkedin-runtime.js';
import { FakePage, type FakePageScript } from '../browser/fake-driver.js';

const NOW = new Date('2026-06-02T12:00:00.000Z');
const logger = { debug(): void {}, warn(): void {} };

function makeAdapter(script: FakePageScript) {
  const page = new FakePage(script);
  const adapter = new LinkedInRuntimeAdapter({ page, clock: () => NOW, logger });
  return { adapter, page };
}

const answer: AnswerProvider = () => Promise.resolve({ value: 'Yes', source: 'frequent_answer' });

describe('LinkedInRuntimeAdapter', () => {
  describe('validateSession', () => {
    it('reports authenticated when the logged-in nav marker exists', async () => {
      const { adapter } = makeAdapter({ exists: { '.global-nav__me': true } });
      const res = await adapter.validateSession();
      expect(res.status).toBe('authenticated');
    });

    it('reports expired when the marker is absent', async () => {
      const { adapter } = makeAdapter({ exists: {} });
      const res = await adapter.validateSession();
      expect(res.status).toBe('expired');
    });

    it('reports blocked when a challenge is detected', async () => {
      const { adapter } = makeAdapter({ iframeSrcs: ['https://www.google.com/recaptcha/api2'] });
      const res = await adapter.validateSession();
      expect(res.status).toBe('blocked');
    });
  });

  describe('search', () => {
    it('yields normalized jobs from the card data island', async () => {
      const cards = JSON.stringify([
        { url: 'https://www.linkedin.com/jobs/view/3856120947', title: 'Backend Engineer', company: 'Acme', postedRelative: '2 hours ago', workplaceType: 'Remote' },
        { url: 'https://www.linkedin.com/jobs/view/4001234567', title: 'Go Dev', company: 'Hooli', postedRelative: '1 day ago' },
      ]);
      const { adapter } = makeAdapter({
        exists: { 'ul.jobs-search__results-list': true },
        attr: { '[data-apex-cards]|data-apex-cards': cards },
      });
      const out = [];
      for await (const job of adapter.search({ query: 'engineer' })) out.push(job);
      expect(out).toHaveLength(2);
      expect(out[0]?.externalId).toBe('3856120947');
      expect(out[0]?.remoteKind).toBe('remote');
      expect(out[1]?.externalId).toBe('4001234567');
    });

    it('returns nothing when the results list selector is missing (drift)', async () => {
      const { adapter } = makeAdapter({ exists: {} });
      const out = [];
      for await (const job of adapter.search({ query: 'x' })) out.push(job);
      expect(out).toHaveLength(0);
    });
  });

  describe('applyEasy', () => {
    const plan: ApplicationPlan = {
      applicationId: 'app-1',
      resumeVersionId: 'rv-1',
      allowAiAnswers: true,
      mode: 'autonomous',
    };
    const job = { url: 'https://www.linkedin.com/jobs/view/3856120947' } as JobDetail;

    it('stops and emits captcha.detected when a challenge appears before apply', async () => {
      const { adapter } = makeAdapter({ iframeSrcs: ['https://hcaptcha.com/1/api.js'] });
      const events = [];
      for await (const e of adapter.applyEasy(job, plan, answer)) events.push(e);
      expect(events.some((e) => e.kind === 'captcha.detected')).toBe(true);
      expect(events.some((e) => e.kind === 'submitted')).toBe(false);
    });

    it('drives to submission when the submit button is present', async () => {
      const { adapter, page } = makeAdapter({
        exists: {
          '[data-test-id="jobs-apply-button"]': true,
          'button[aria-label="Submit application"]': true,
        },
      });
      const events = [];
      for await (const e of adapter.applyEasy(job, plan, answer)) events.push(e);
      expect(events.some((e) => e.kind === 'submitted')).toBe(true);
      // It clicked the easy-apply then the submit button.
      expect(page.clicks).toContain('[data-test-id="jobs-apply-button"]');
      expect(page.clicks).toContain('button[aria-label="Submit application"]');
    });

    it('fails when the easy-apply button cannot be found', async () => {
      const { adapter } = makeAdapter({ exists: {} });
      const events = [];
      for await (const e of adapter.applyEasy(job, plan, answer)) events.push(e);
      const failed = events.find((e) => e.kind === 'step.failed');
      expect(failed).toBeDefined();
    });
  });
});
