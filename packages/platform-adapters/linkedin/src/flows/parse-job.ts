// parse-job — open a job page and extract the full JobDetail.

import type { AdapterContext, JobDetail } from '@apex/automation-core';
import { resolveLayered, peekLayered } from '@apex/automation-core';
import {
  JOB_APPLICANTS_COUNT,
  JOB_COMPANY,
  JOB_DESCRIPTION,
  JOB_LOCATION,
  JOB_POSTED_TEXT,
  JOB_TITLE,
} from '../selectors.js';
import { ADAPTER_VERSION } from '../version.js';
import { buildCanonicalKey } from './canonical-key.js';
import { parsePostedTime } from './parse-posted-time.js';
import { Domain } from '@apex/shared-types';

export async function parseLinkedInJob(ctx: AdapterContext, jobUrl: string): Promise<JobDetail> {
  await ctx.pace('navigate');
  await ctx.page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await ctx.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);

  const titleLoc = await resolveLayered(ctx.page, JOB_TITLE, {
    platformKey: 'linkedin',
    adapterVersion: ADAPTER_VERSION,
    totalTimeoutMs: 8_000,
  });
  const title = ((await titleLoc.textContent({ timeout: 1_500 })) ?? '').trim();

  const company = await safeText(ctx, JOB_COMPANY);
  const location = await safeText(ctx, JOB_LOCATION);
  const description = await safeText(ctx, JOB_DESCRIPTION, 25_000);
  const applicantsText = await safeText(ctx, JOB_APPLICANTS_COUNT);
  const postedText = await safeText(ctx, JOB_POSTED_TEXT);

  const postedAtParsed = parsePostedTime(postedText, null, ctx.now());
  const externalId = extractJobIdFromUrl(jobUrl) ?? jobUrl;
  const remoteKind = detectRemoteKind(`${title} ${location ?? ''} ${description ?? ''}`);

  const ageMin = postedAtParsed
    ? Math.max(0, (ctx.now().getTime() - postedAtParsed.at.getTime()) / 60_000)
    : null;
  const freshness: JobDetail['freshness'] = ageMin === null
    ? null
    : ageMin <= Domain.FRESHNESS_WINDOWS_MIN.t5h
      ? 't5h'
      : ageMin <= Domain.FRESHNESS_WINDOWS_MIN.t12h
        ? 't12h'
        : ageMin <= Domain.FRESHNESS_WINDOWS_MIN.t24h
          ? 't24h'
          : ageMin <= Domain.FRESHNESS_WINDOWS_MIN.t5d
            ? 't5d'
            : 'stale';

  return {
    externalId,
    url: jobUrl,
    title,
    company,
    location,
    remoteKind,
    postedAt: postedAtParsed?.at ?? null,
    postedAtUncertain: postedAtParsed?.uncertain ?? true,
    freshness,
    snippet: null,
    applicants: parseApplicantsCount(applicantsText),
    salaryMin: null,
    salaryMax: null,
    currency: null,
    isQuickApply: null,
    canonicalKey: buildCanonicalKey({ company, title, location }),
    requiredSkills: extractKeywords(description ?? ''),
    descriptionMd: description,
    raw: {
      applicantsText,
      postedText,
      adapterVersion: ADAPTER_VERSION,
    },
  };
}

async function safeText(ctx: AdapterContext, sel: typeof JOB_TITLE, sliceLen?: number): Promise<string | null> {
  const loc = await peekLayered(ctx.page, sel, 800);
  if (!loc) return null;
  try {
    const t = ((await loc.textContent({ timeout: 800 })) ?? '').trim();
    if (t.length === 0) return null;
    return sliceLen !== undefined && t.length > sliceLen ? `${t.slice(0, sliceLen - 1)}…` : t;
  } catch {
    return null;
  }
}

function extractJobIdFromUrl(url: string): string | null {
  const m = /\/jobs\/view\/(\d+)/.exec(url);
  return m ? m[1] ?? null : null;
}

function detectRemoteKind(text: string): JobDetail['remoteKind'] {
  const t = text.toLowerCase();
  if (/\bremote\b/.test(t) || /\bwork from home\b/.test(t)) return 'remote';
  if (/\bhybrid\b/.test(t)) return 'hybrid';
  if (/\bon[._-]?site\b/.test(t) || /\bin office\b/.test(t)) return 'onsite';
  return null;
}

function parseApplicantsCount(text: string | null): number | null {
  if (!text) return null;
  const m = /(\d{1,4})\+?/.exec(text);
  if (!m || !m[1]) return null;
  return parseInt(m[1], 10);
}

/**
 * Best-effort keyword extraction from a job description. The real AI scorer
 * consumes the full description; this is for quick local heuristics
 * (filtering manager + the deterministic stand-in scorer).
 */
function extractKeywords(text: string): string[] {
  const tokens = new Set<string>();
  // Capture phrases like "TypeScript", "PostgreSQL", "Kubernetes" — title-case
  // technical terms in the body.
  const re = /\b([A-Z][a-zA-Z+#./-]{2,24})\b/g;
  let m: RegExpExecArray | null = null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) tokens.add(m[1].toLowerCase());
  }
  return Array.from(tokens).slice(0, 64);
}
