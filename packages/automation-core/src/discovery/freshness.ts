// Freshness parsing, tiering, and priority ordering for discovery.
//
// Reference: docs/architecture/06-automation-engine.md §9–§11.
//
// Tiers: t5h → t12h → t24h → t5d; anything older than 5 days is discarded.
// Uncertain postings are treated one tier worse than they look. Within a tier,
// jobs are ordered by AI score descending. All pure & deterministic.

export type FreshnessTier = 't5h' | 't12h' | 't24h' | 't5d' | 'stale';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Tier boundaries in milliseconds (inclusive upper bound). */
const TIER_BOUNDS: Array<{ tier: Exclude<FreshnessTier, 'stale'>; maxAgeMs: number }> = [
  { tier: 't5h', maxAgeMs: 5 * HOUR_MS },
  { tier: 't12h', maxAgeMs: 12 * HOUR_MS },
  { tier: 't24h', maxAgeMs: 24 * HOUR_MS },
  { tier: 't5d', maxAgeMs: 5 * DAY_MS },
];

const TIER_ORDER: FreshnessTier[] = ['t5h', 't12h', 't24h', 't5d', 'stale'];

/** Numeric rank for a tier (lower = fresher = higher priority). */
export function tierRank(tier: FreshnessTier): number {
  return TIER_ORDER.indexOf(tier);
}

/**
 * Classify a posting age into a freshness tier. `uncertain` postings are demoted
 * one tier (the orchestrator treats them as one tier worse — §9).
 */
export function classifyFreshness(postedAt: Date | null, now: Date, uncertain = false): FreshnessTier {
  if (postedAt === null) return uncertain ? 'stale' : 't5d';
  const ageMs = now.getTime() - postedAt.getTime();
  if (ageMs < 0) return demote('t5h', uncertain); // clock skew: treat as freshest (minus demotion)

  let base: FreshnessTier = 'stale';
  for (const { tier, maxAgeMs } of TIER_BOUNDS) {
    if (ageMs <= maxAgeMs) {
      base = tier;
      break;
    }
  }
  return demote(base, uncertain);
}

function demote(tier: FreshnessTier, uncertain: boolean): FreshnessTier {
  if (!uncertain || tier === 'stale') return tier;
  const idx = tierRank(tier);
  return TIER_ORDER[Math.min(idx + 1, TIER_ORDER.length - 1)]!;
}

export function isWithinFreshnessWindow(tier: FreshnessTier): boolean {
  return tier !== 'stale';
}

/**
 * Parse a platform's relative time string ("posted 4 hours ago", "2 days ago",
 * "just now", "yesterday") into an absolute Date using the worker clock.
 * Returns null when nothing usable can be derived (caller marks uncertain).
 */
export function parseRelativePostedAt(text: string, now: Date): Date | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  if (/just now|moments? ago|few (seconds|minutes) ago/.test(t)) return new Date(now.getTime());
  if (/\byesterday\b/.test(t)) return new Date(now.getTime() - DAY_MS);
  if (/\btoday\b/.test(t)) return new Date(now.getTime());

  const m = /(\d+)\s*(second|minute|hour|day|week|month)s?/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!;
  const unitMs: Record<string, number> = {
    second: 1000,
    minute: 60_000,
    hour: HOUR_MS,
    day: DAY_MS,
    week: 7 * DAY_MS,
    month: 30 * DAY_MS,
  };
  const delta = unitMs[unit];
  if (delta === undefined) return null;
  return new Date(now.getTime() - n * delta);
}

/** Resolve posted_at from either an absolute ISO string or a relative phrase. */
export function resolvePostedAt(
  raw: { absoluteIso?: string | undefined; relativeText?: string | undefined },
  now: Date,
): { postedAt: Date | null; uncertain: boolean } {
  if (raw.absoluteIso) {
    const d = new Date(raw.absoluteIso);
    if (!Number.isNaN(d.getTime())) return { postedAt: d, uncertain: false };
  }
  if (raw.relativeText) {
    const d = parseRelativePostedAt(raw.relativeText, now);
    if (d) return { postedAt: d, uncertain: false };
    // A vague phrase like "recently" → fall back to fetch time, flagged uncertain.
    if (/recently|new/.test(raw.relativeText.toLowerCase())) {
      return { postedAt: new Date(now.getTime()), uncertain: true };
    }
  }
  return { postedAt: null, uncertain: true };
}

export interface PrioritizableJob {
  externalId: string;
  tier: FreshnessTier;
  /** AI relevance score in [0, 1]; undefined when not yet scored. */
  score?: number | undefined;
}

/**
 * Order jobs for the apply queue: by freshness tier (t5h first), then by AI
 * score descending within a tier, then by externalId for stable ties. Stale
 * jobs are filtered out entirely.
 */
export function prioritize<T extends PrioritizableJob>(jobs: T[]): T[] {
  return jobs
    .filter((j) => isWithinFreshnessWindow(j.tier))
    .slice()
    .sort((a, b) => {
      const tr = tierRank(a.tier) - tierRank(b.tier);
      if (tr !== 0) return tr;
      const sb = (b.score ?? -1) - (a.score ?? -1);
      if (sb !== 0) return sb;
      return a.externalId.localeCompare(b.externalId);
    });
}
