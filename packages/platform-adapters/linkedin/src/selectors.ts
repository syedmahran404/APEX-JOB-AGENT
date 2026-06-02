// LinkedIn layered selector catalog. Each logical element lists ordered
// strategies (stable test ids / roles first, brittle CSS / nth last). The
// worker resolves them via @apex/automation-core's resolveLayered(). Keeping the
// catalog as data (not imperative queries) means the adapter is unit-testable
// and drift is observable.
//
// Reference: docs/architecture/06-automation-engine.md §3, §14.

import { layered, type LayeredSelector } from '@apex/automation-core';

export const LINKEDIN_SELECTORS = {
  searchResultsList: layered('searchResultsList', [
    { kind: 'css', value: 'ul.jobs-search__results-list' },
    { kind: 'role', value: 'list[aria-label="Job search results"]' },
    { kind: 'css', value: 'div.jobs-search-results-list' },
  ]),
  searchResultItem: layered('searchResultItem', [
    { kind: 'css', value: 'li.jobs-search-results__list-item' },
    { kind: 'css', value: 'div.job-card-container' },
  ]),
  jobTitle: layered('jobTitle', [
    { kind: 'testid', value: 'job-details-jobs-unified-top-card__job-title' },
    { kind: 'css', value: 'h1.top-card-layout__title' },
    { kind: 'css', value: 'h2.jobs-unified-top-card__job-title' },
  ]),
  companyName: layered('companyName', [
    { kind: 'css', value: 'a.topcard__org-name-link' },
    { kind: 'css', value: 'span.jobs-unified-top-card__company-name' },
    { kind: 'css', value: 'div.job-details-jobs-unified-top-card__company-name' },
  ]),
  jobLocation: layered('jobLocation', [
    { kind: 'css', value: 'span.topcard__flavor--bullet' },
    { kind: 'css', value: 'span.jobs-unified-top-card__bullet' },
  ]),
  postedAt: layered('postedAt', [
    { kind: 'css', value: 'span.posted-time-ago__text' },
    { kind: 'css', value: 'span.jobs-unified-top-card__posted-date' },
    { kind: 'css', value: 'time' },
  ]),
  jobDescription: layered('jobDescription', [
    { kind: 'css', value: 'div.show-more-less-html__markup' },
    { kind: 'css', value: 'div.jobs-description__content' },
  ]),
  easyApplyButton: layered('easyApplyButton', [
    { kind: 'testid', value: 'jobs-apply-button' },
    { kind: 'role', value: 'button[aria-label^="Easy Apply"]' },
    { kind: 'css', value: 'button.jobs-apply-button' },
    { kind: 'text', value: 'Easy Apply' },
  ]),
  externalApplyButton: layered('externalApplyButton', [
    { kind: 'role', value: 'button[aria-label^="Apply"]' },
    { kind: 'text', value: 'Apply on company website' },
  ]),
  applyModal: layered('applyModal', [
    { kind: 'role', value: 'dialog[aria-label^="Apply"]' },
    { kind: 'css', value: 'div.jobs-easy-apply-modal' },
  ]),
  nextButton: layered('nextButton', [
    { kind: 'role', value: 'button[aria-label="Continue to next step"]' },
    { kind: 'text', value: 'Next' },
  ]),
  reviewButton: layered('reviewButton', [
    { kind: 'role', value: 'button[aria-label="Review your application"]' },
    { kind: 'text', value: 'Review' },
  ]),
  submitButton: layered('submitButton', [
    { kind: 'role', value: 'button[aria-label="Submit application"]' },
    { kind: 'text', value: 'Submit application' },
  ]),
  resumeUploadInput: layered('resumeUploadInput', [
    { kind: 'css', value: 'input[type="file"][name="file"]' },
    { kind: 'css', value: 'input[type="file"]' },
  ]),
  alreadyAppliedBadge: layered('alreadyAppliedBadge', [
    { kind: 'css', value: 'span.artdeco-inline-feedback--success' },
    { kind: 'text', value: 'Applied' },
  ]),
} as const satisfies Record<string, LayeredSelector>;

/** Selectors whose contents must be blurred in screenshots before persistence. */
export const LINKEDIN_SENSITIVE_SELECTORS: string[] = [
  'input[type="password"]',
  'input[name="pin"]',
  'input[autocomplete="one-time-code"]',
  'input[name="session_password"]',
];

export type LinkedInSelectorName = keyof typeof LINKEDIN_SELECTORS;
