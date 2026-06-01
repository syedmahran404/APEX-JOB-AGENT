// ATS detector — when a job site links out to a third-party Applicant
// Tracking System, we surface the detection so the engine emits a
// `skipped_external_ats` outcome with a useful reason (audit fix C6).
//
// Phase 2 detects: Workday, Greenhouse, Lever, SmartRecruiters, Ashby, iCIMS.
// Phase 9 ships dedicated adapters for the top three.

import type { Page } from 'playwright';

export type AtsKind =
  | 'workday'
  | 'greenhouse'
  | 'lever'
  | 'smartrecruiters'
  | 'ashby'
  | 'icims'
  | 'unknown';

interface AtsSignature {
  kind: AtsKind;
  hostPatterns: ReadonlyArray<RegExp>;
  domSelectors: ReadonlyArray<string>;
}

const SIGNATURES: ReadonlyArray<AtsSignature> = [
  {
    kind: 'workday',
    hostPatterns: [/\.myworkdayjobs\.com$/i, /\.workday\.com$/i, /\.wd[0-9]+\.myworkdayjobs\.com$/i],
    domSelectors: ['[data-automation-id]', 'div[data-automation-id="jobPostingHeader"]'],
  },
  {
    kind: 'greenhouse',
    hostPatterns: [/^boards\.greenhouse\.io$/i, /\.greenhouse\.io$/i],
    domSelectors: ['#main #app_body', 'div#wrapper #content'],
  },
  {
    kind: 'lever',
    hostPatterns: [/^jobs\.lever\.co$/i, /\.lever\.co$/i],
    domSelectors: ['div[data-qa="posting-name"]', 'div.posting-page'],
  },
  {
    kind: 'smartrecruiters',
    hostPatterns: [/\.smartrecruiters\.com$/i, /^careers\..+\.smartrecruiters\.com$/i],
    domSelectors: ['div.application-form', 'div.sr-jobad'],
  },
  {
    kind: 'ashby',
    hostPatterns: [/^jobs\.ashbyhq\.com$/i, /\.ashbyhq\.com$/i],
    domSelectors: ['div[class*="ashby"]'],
  },
  {
    kind: 'icims',
    hostPatterns: [/\.icims\.com$/i],
    domSelectors: ['#icims_content_iframe'],
  },
];

/** Detect ATS by URL only (cheap; no DOM access). */
export function detectAtsByUrl(url: string): AtsKind {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return 'unknown';
  }
  for (const sig of SIGNATURES) {
    if (sig.hostPatterns.some((p) => p.test(host))) return sig.kind;
  }
  return 'unknown';
}

/** Detect ATS by inspecting the live page's DOM. URL takes precedence. */
export async function detectAtsOnPage(page: Page): Promise<AtsKind> {
  const byUrl = detectAtsByUrl(page.url());
  if (byUrl !== 'unknown') return byUrl;

  for (const sig of SIGNATURES) {
    for (const selector of sig.domSelectors) {
      try {
        const count = await page.locator(selector).count();
        if (count > 0) return sig.kind;
      } catch {
        // ignore selector errors and try next
      }
    }
  }
  return 'unknown';
}
