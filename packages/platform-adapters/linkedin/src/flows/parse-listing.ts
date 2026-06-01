// parse-listing — extract DiscoveredJob fields from a single search-result card.
//
// Listing-card extraction is forgiving: missing fields don't fail the whole
// pipeline; we surface what we have. The JOB_TITLE selector is the only
// hard requirement (without it the row is unusable).

import type { Locator } from 'playwright';
import { Domain } from '@apex/shared-types';
import type { DiscoveredJob } from '@apex/automation-core';
import {
  SEARCH_CARD_APPLIED_BADGE,
  SEARCH_CARD_COMPANY,
  SEARCH_CARD_LOCATION,
  SEARCH_CARD_POSTED,
  SEARCH_CARD_TITLE,
} from '../selectors.js';
import { peekLayered } from '@apex/automation-core';
import { buildCanonicalKey } from './canonical-key.js';
import { parsePostedTime } from './parse-posted-time.js';

export interface ParseListingArgs {
  card: Locator;
  /** Authoritative clock for freshness tier computation. */
  now: () => Date;
}

export async function parseListingCard(args: ParseListingArgs): Promise<DiscoveredJob | null> {
  const titleLocator = await peekLayered(args.card.page(), SEARCH_CARD_TITLE);
  if (!titleLocator) return null;
  // Card-scoped query so we don't pick up another row's title.
  const titleEl = args.card.locator(SEARCH_CARD_TITLE.layers.map((l) => l.selector).join(', ')).first();
  const title = await safeText(titleEl);
  if (!title) return null;
  const url = await safeAttr(titleEl, 'href');
  const externalId = extractJobId(url);
  if (!externalId) return null;
  const fullUrl = absolutize(url ?? '');

  const companyEl = args.card.locator(SEARCH_CARD_COMPANY.layers.map((l) => l.selector).join(', ')).first();
  const company = await safeText(companyEl);

  const locationEl = args.card.locator(SEARCH_CARD_LOCATION.layers.map((l) => l.selector).join(', ')).first();
  const location = await safeText(locationEl);

  const postedEl = args.card.locator(SEARCH_CARD_POSTED.layers.map((l) => l.selector).join(', ')).first();
  const postedTimeText = await safeText(postedEl);
  const postedDateAttr = await safeAttr(postedEl, 'datetime');
  const postedAtParsed = parsePostedTime(postedTimeText, postedDateAttr, args.now());

  const appliedBadge = await peekLayered(args.card.page(), SEARCH_CARD_APPLIED_BADGE, 100);
  const looksApplied = appliedBadge !== null;

  const freshness: DiscoveredJob['freshness'] = postedAtParsed
    ? freshnessFor(postedAtParsed.at, args.now(), postedAtParsed.uncertain)
    : null;

  const canonicalKey = buildCanonicalKey({ company, title, location });

  return {
    externalId,
    url: fullUrl,
    title,
    company,
    location,
    remoteKind: detectRemoteKindFromText(`${title} ${location ?? ''}`),
    postedAt: postedAtParsed?.at ?? null,
    postedAtUncertain: postedAtParsed?.uncertain ?? true,
    freshness,
    snippet: null,
    applicants: null,
    salaryMin: null,
    salaryMax: null,
    currency: null,
    isQuickApply: looksApplied ? false : null, // honest about uncertainty
    canonicalKey,
    requiredSkills: [],
  };
}

async function safeText(loc: Locator): Promise<string | null> {
  try {
    const t = (await loc.textContent({ timeout: 250 })) ?? '';
    const trimmed = t.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

async function safeAttr(loc: Locator, attr: string): Promise<string | null> {
  try {
    return await loc.getAttribute(attr, { timeout: 250 });
  } catch {
    return null;
  }
}

/** Extract jobId from `/jobs/view/3878...` and `/jobs/collections/...?currentJobId=3878...`. */
function extractJobId(url: string | null): string | null {
  if (!url) return null;
  const view = /\/jobs\/view\/(\d+)/.exec(url);
  if (view) return view[1] ?? null;
  const param = /[?&]currentJobId=(\d+)/.exec(url);
  if (param) return param[1] ?? null;
  return null;
}

function absolutize(href: string): string {
  if (href.startsWith('http')) return href;
  return `https://www.linkedin.com${href.startsWith('/') ? href : `/${href}`}`;
}

function freshnessFor(
  postedAt: Date,
  now: Date,
  uncertain: boolean,
): DiscoveredJob['freshness'] {
  const ageMin = Math.max(0, (now.getTime() - postedAt.getTime()) / 60_000);
  let tier: NonNullable<DiscoveredJob['freshness']>;
  if (ageMin <= Domain.FRESHNESS_WINDOWS_MIN.t5h) tier = 't5h';
  else if (ageMin <= Domain.FRESHNESS_WINDOWS_MIN.t12h) tier = 't12h';
  else if (ageMin <= Domain.FRESHNESS_WINDOWS_MIN.t24h) tier = 't24h';
  else if (ageMin <= Domain.FRESHNESS_WINDOWS_MIN.t5d) tier = 't5d';
  else tier = 'stale';
  // Audit fix Phase 6 §9: uncertain timestamps drop one tier (more conservative).
  if (uncertain && tier !== 'stale') {
    const order: Array<NonNullable<DiscoveredJob['freshness']>> = ['t5h', 't12h', 't24h', 't5d', 'stale'];
    const idx = order.indexOf(tier);
    if (idx >= 0) tier = order[Math.min(idx + 1, order.length - 1)] ?? tier;
  }
  return tier;
}

function detectRemoteKindFromText(text: string): DiscoveredJob['remoteKind'] {
  const t = text.toLowerCase();
  if (/\bremote\b/.test(t) || /\bwork from home\b/.test(t)) return 'remote';
  if (/\bhybrid\b/.test(t)) return 'hybrid';
  if (/\bon[._-]?site\b/.test(t)) return 'onsite';
  return null;
}
