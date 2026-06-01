// LinkedIn DOM selectors, layered for graceful degradation.
//
// Layer order: the most-specific / most-stable identifier first; visible
// fallbacks last. The first layer that resolves wins (see
// @apex/automation-core/selectors/helpers).
//
// Selectors are based on LinkedIn's observed public DOM patterns. They will
// drift over time. The engine handles drift cleanly:
//   1. SelectorDriftError → screenshot + DOM snapshot + `failed_selector_drift`.
//   2. Nightly canary detects the drift before users do.
//   3. Adapter version is bumped in a hotfix.

import type { LayeredSelector } from '@apex/automation-core';

export const LINKEDIN_BASE_URL = 'https://www.linkedin.com';
export const LINKEDIN_LOGIN_URL = `${LINKEDIN_BASE_URL}/login`;
export const LINKEDIN_FEED_URL = `${LINKEDIN_BASE_URL}/feed/`;
export const LINKEDIN_JOBS_SEARCH_URL = `${LINKEDIN_BASE_URL}/jobs/search/`;

// =============================================================================
// LOGIN
// =============================================================================

export const LOGIN_USERNAME_INPUT: LayeredSelector = {
  name: 'login-username-input',
  layers: [
    { selector: 'input#username', visible: true, label: 'username' },
    { selector: 'input[name="session_key"]', visible: true },
    { selector: 'input[autocomplete="username"]', visible: true },
  ],
};

export const LOGIN_PASSWORD_INPUT: LayeredSelector = {
  name: 'login-password-input',
  layers: [
    { selector: 'input#password', visible: true, label: 'password' },
    { selector: 'input[name="session_password"]', visible: true },
    { selector: 'input[type="password"][autocomplete="current-password"]', visible: true },
  ],
};

export const LOGIN_SUBMIT_BUTTON: LayeredSelector = {
  name: 'login-submit-button',
  layers: [
    { selector: 'button[type="submit"][aria-label*="Sign in" i]', visible: true },
    { selector: 'button[data-litms-control-urn*="login-submit"]', visible: true },
    { selector: 'button[type="submit"]', visible: true },
  ],
};

export const LOGIN_ERROR_BANNER: LayeredSelector = {
  name: 'login-error-banner',
  layers: [
    { selector: 'div#error-for-username', visible: true },
    { selector: 'div#error-for-password', visible: true },
    { selector: 'div[role="alert"]', visible: true },
  ],
};

// Indicators that we're already authenticated (any of these visible = logged in).
export const LOGGED_IN_INDICATOR: LayeredSelector = {
  name: 'logged-in-indicator',
  layers: [
    { selector: 'header.global-nav', visible: true },
    { selector: 'div.feed-identity-module' },
    { selector: 'a[href="/feed/"]' },
  ],
};

// =============================================================================
// SEARCH RESULTS
// =============================================================================

export const SEARCH_RESULTS_LIST: LayeredSelector = {
  name: 'search-results-list',
  layers: [
    { selector: 'div.scaffold-layout__list ul li[data-occludable-job-id]' },
    { selector: '.jobs-search-results-list li[data-occludable-job-id]' },
    { selector: 'ul.jobs-search-results__list > li' },
  ],
};

export const SEARCH_CARD_TITLE: LayeredSelector = {
  name: 'search-card-title',
  layers: [
    { selector: 'a.job-card-list__title' },
    { selector: 'a.job-card-container__link' },
    { selector: 'h3.base-search-card__title' },
  ],
};

export const SEARCH_CARD_COMPANY: LayeredSelector = {
  name: 'search-card-company',
  layers: [
    { selector: 'span.job-card-container__primary-description' },
    { selector: 'h4.base-search-card__subtitle' },
    { selector: '.job-card-container__company-name' },
  ],
};

export const SEARCH_CARD_LOCATION: LayeredSelector = {
  name: 'search-card-location',
  layers: [
    { selector: 'li.job-card-container__metadata-item' },
    { selector: '.job-card-container__metadata-wrapper li' },
    { selector: '.base-search-card__metadata' },
  ],
};

export const SEARCH_CARD_POSTED: LayeredSelector = {
  name: 'search-card-posted',
  layers: [
    { selector: 'time' },
    { selector: 'span.job-search-card__listdate' },
    { selector: 'span.job-search-card__listdate--new' },
  ],
};

export const SEARCH_CARD_APPLIED_BADGE: LayeredSelector = {
  name: 'search-card-applied-badge',
  layers: [
    { selector: 'li.jobs-search-results__list-item--is-applied' },
    { selector: 'span.job-card-container__footer-item--highlighted' },
    { selector: '.tvm__text--neutral' },
  ],
};

export const SEARCH_NEXT_PAGE_BUTTON: LayeredSelector = {
  name: 'search-next-page-button',
  layers: [
    { selector: 'button[aria-label*="next page" i]' },
    { selector: 'button[aria-label*="Page" i][aria-label*="next" i]' },
    { selector: 'li.artdeco-pagination__indicator--number.active + li button' },
  ],
};

// =============================================================================
// JOB DETAIL PAGE
// =============================================================================

export const JOB_TITLE: LayeredSelector = {
  name: 'job-title',
  layers: [
    { selector: 'h1.jobs-unified-top-card__job-title', visible: true },
    { selector: 'h1.t-24' },
    { selector: 'h1[class*="top-card"][class*="title"]' },
  ],
};

export const JOB_COMPANY: LayeredSelector = {
  name: 'job-company',
  layers: [
    { selector: 'div.jobs-unified-top-card__company-name a' },
    { selector: 'a.topcard__org-name-link' },
    { selector: '.jobs-unified-top-card__company-name' },
  ],
};

export const JOB_LOCATION: LayeredSelector = {
  name: 'job-location',
  layers: [
    { selector: 'span.jobs-unified-top-card__bullet' },
    { selector: '.jobs-unified-top-card__primary-description-without-tagline' },
    { selector: '.topcard__flavor--bullet' },
  ],
};

export const JOB_DESCRIPTION: LayeredSelector = {
  name: 'job-description',
  layers: [
    { selector: 'div.jobs-description-content' },
    { selector: 'div.jobs-description__content' },
    { selector: 'div#job-details' },
  ],
};

export const JOB_APPLICANTS_COUNT: LayeredSelector = {
  name: 'job-applicants-count',
  layers: [
    { selector: 'span.jobs-unified-top-card__applicant-count' },
    { selector: '.num-applicants__caption' },
  ],
};

export const JOB_POSTED_TEXT: LayeredSelector = {
  name: 'job-posted-text',
  layers: [
    { selector: '.jobs-unified-top-card__posted-date' },
    { selector: 'span.posted-time-ago__text' },
    { selector: 'span.topcard__flavor--metadata' },
  ],
};

// =============================================================================
// EASY APPLY
// =============================================================================

export const EASY_APPLY_BUTTON: LayeredSelector = {
  name: 'easy-apply-button',
  layers: [
    { selector: 'button.jobs-apply-button[data-control-name*="apply"]', visible: true },
    { selector: 'button[aria-label*="Easy Apply" i]', visible: true },
    { selector: 'button.jobs-apply-button', visible: true },
  ],
};

export const APPLY_BUTTON_GENERIC: LayeredSelector = {
  name: 'apply-button-generic',
  layers: [
    { selector: 'button[aria-label*="Apply" i]', visible: true },
    { selector: 'a[aria-label*="Apply on company website" i]', visible: true },
  ],
};

export const APPLIED_INDICATOR: LayeredSelector = {
  name: 'applied-indicator',
  layers: [
    { selector: 'span.artdeco-inline-feedback__message' },
    { selector: '.jobs-applied-card__applied-banner' },
    { selector: 'div[aria-label*="Applied" i]' },
  ],
};

// Easy Apply modal
export const EASY_APPLY_MODAL: LayeredSelector = {
  name: 'easy-apply-modal',
  layers: [
    { selector: 'div.jobs-easy-apply-modal', visible: true },
    { selector: 'div[aria-labelledby*="jobs-apply-header"]', visible: true },
    { selector: 'div.artdeco-modal[role="dialog"]', visible: true },
  ],
};

export const EASY_APPLY_NEXT_BUTTON: LayeredSelector = {
  name: 'easy-apply-next-button',
  layers: [
    { selector: 'button[aria-label*="Continue to next step" i]', visible: true },
    { selector: 'button[aria-label*="Next" i]', visible: true },
  ],
};

export const EASY_APPLY_REVIEW_BUTTON: LayeredSelector = {
  name: 'easy-apply-review-button',
  layers: [
    { selector: 'button[aria-label*="Review your application" i]', visible: true },
    { selector: 'button[aria-label*="Review" i]', visible: true },
  ],
};

export const EASY_APPLY_SUBMIT_BUTTON: LayeredSelector = {
  name: 'easy-apply-submit-button',
  layers: [
    { selector: 'button[aria-label*="Submit application" i]', visible: true },
    { selector: 'button.artdeco-button--primary[aria-label*="Submit" i]', visible: true },
  ],
};

export const EASY_APPLY_DISMISS_BUTTON: LayeredSelector = {
  name: 'easy-apply-dismiss-button',
  layers: [
    { selector: 'button[aria-label*="Dismiss" i]' },
    { selector: 'button.artdeco-modal__dismiss' },
  ],
};

// Confirmation
export const EASY_APPLY_DONE_BANNER: LayeredSelector = {
  name: 'easy-apply-done-banner',
  layers: [
    { selector: 'h2[id*="post-apply"]' },
    { selector: 'div.jobs-post-apply' },
    { selector: 'div[aria-labelledby*="post-apply-header"]' },
  ],
};

// Resume select inside modal.
export const EASY_APPLY_RESUME_RADIO: LayeredSelector = {
  name: 'easy-apply-resume-radio',
  layers: [
    { selector: 'label.jobs-resume-picker__resume-label' },
    { selector: 'div.jobs-resume-picker input[type="radio"]' },
  ],
};

export const EASY_APPLY_RESUME_UPLOAD: LayeredSelector = {
  name: 'easy-apply-resume-upload',
  layers: [
    { selector: 'input[type="file"][name="file"]' },
    { selector: 'input[type="file"][accept*="pdf"]' },
  ],
};

// Generic question container in the apply form.
export const EASY_APPLY_QUESTION_GROUP: LayeredSelector = {
  name: 'easy-apply-question-group',
  layers: [
    { selector: 'div.jobs-easy-apply-form-section__grouping' },
    { selector: 'div.fb-form-element' },
    { selector: 'div[data-test-form-element]' },
  ],
};

export const EASY_APPLY_FORM_SUBMIT_DISABLED: LayeredSelector = {
  name: 'easy-apply-form-submit-disabled',
  layers: [
    { selector: 'button[aria-label*="Submit application" i][disabled]' },
    { selector: 'button.artdeco-button--primary[disabled]' },
  ],
};

// Sensitive field selectors — blurred before screenshot.
export const SENSITIVE_FIELD_SELECTORS: ReadonlyArray<string> = [
  'input[type="password"]',
  'input[autocomplete="one-time-code"]',
  'input[type="tel"]',
  'input[name*="phone" i]',
  'input[name*="ssn" i]',
];
