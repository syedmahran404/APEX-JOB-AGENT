// parse-posted-time — convert LinkedIn's relative posting strings + optional
// `datetime` attribute into a (Date, uncertain) tuple.
//
// LinkedIn shows things like:
//   "Posted 4 hours ago"
//   "Posted 2 days ago"
//   "Posted just now"
//   "Reposted 1 week ago"
// In some surfaces, the <time> element carries an absolute `datetime` attr;
// when it does, we prefer it (uncertain=false).

const REL_PATTERNS: ReadonlyArray<{ re: RegExp; toMin: (n: number) => number }> = [
  { re: /just now|moments? ago/i, toMin: () => 0 },
  { re: /(\d+)\s*minutes?\s*ago/i, toMin: (n) => n },
  { re: /an?\s*hour\s*ago/i, toMin: () => 60 },
  { re: /(\d+)\s*hours?\s*ago/i, toMin: (n) => n * 60 },
  { re: /(?:a|1)\s*day\s*ago|yesterday/i, toMin: () => 24 * 60 },
  { re: /(\d+)\s*days?\s*ago/i, toMin: (n) => n * 24 * 60 },
  { re: /(?:a|1)\s*week\s*ago/i, toMin: () => 7 * 24 * 60 },
  { re: /(\d+)\s*weeks?\s*ago/i, toMin: (n) => n * 7 * 24 * 60 },
  { re: /(?:a|1)\s*month\s*ago/i, toMin: () => 30 * 24 * 60 },
  { re: /(\d+)\s*months?\s*ago/i, toMin: (n) => n * 30 * 24 * 60 },
];

export interface ParsedPostedTime {
  at: Date;
  uncertain: boolean;
}

export function parsePostedTime(
  rawText: string | null,
  datetimeAttr: string | null,
  nowAt: Date,
): ParsedPostedTime | null {
  // Prefer absolute datetime when present.
  if (datetimeAttr) {
    const parsed = new Date(datetimeAttr);
    if (!Number.isNaN(parsed.getTime())) {
      return { at: parsed, uncertain: false };
    }
  }
  if (!rawText) return null;
  for (const { re, toMin } of REL_PATTERNS) {
    const m = re.exec(rawText);
    if (m) {
      const n = m[1] ? parseInt(m[1], 10) : 1;
      const minutes = toMin(n);
      const at = new Date(nowAt.getTime() - minutes * 60_000);
      return { at, uncertain: true };
    }
  }
  // Some cards say only "Reposted" without a time — treat as moderately old
  // and uncertain so freshness drops to t5d at best.
  if (/reposted/i.test(rawText)) {
    return { at: new Date(nowAt.getTime() - 24 * 60 * 60_000), uncertain: true };
  }
  return null;
}
