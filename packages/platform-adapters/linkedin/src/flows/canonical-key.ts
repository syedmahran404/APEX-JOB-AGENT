// Canonical-key generator (audit fix C1). Cross-platform dedupe relies on
// (employer, title, coarse-location). Normalization rules:
//   - lowercase, trim, collapse whitespace
//   - strip parenthesized suffixes (e.g., "Senior Engineer (Remote)")
//   - drop common employment-type tokens ("part-time", "contract", "intern")
//   - location bucketing: "Bengaluru, Karnataka, India" → "bengaluru".

const LOCATION_BUCKETS: ReadonlyArray<{ pattern: RegExp; bucket: string }> = [
  { pattern: /\b(bengaluru|bangalore)\b/i, bucket: 'bengaluru' },
  { pattern: /\b(mumbai|bombay)\b/i, bucket: 'mumbai' },
  { pattern: /\b(new delhi|delhi)\b/i, bucket: 'delhi' },
  { pattern: /\b(hyderabad|secunderabad)\b/i, bucket: 'hyderabad' },
  { pattern: /\bpune\b/i, bucket: 'pune' },
  { pattern: /\bchennai\b/i, bucket: 'chennai' },
  { pattern: /\b(noida|gurgaon|gurugram)\b/i, bucket: 'ncr' },
  { pattern: /\bkolkata\b/i, bucket: 'kolkata' },
  { pattern: /\b(san francisco|sf bay|silicon valley|sf)\b/i, bucket: 'sf-bay' },
  { pattern: /\b(new york|nyc)\b/i, bucket: 'nyc' },
  { pattern: /\b(seattle|bellevue|redmond)\b/i, bucket: 'seattle' },
  { pattern: /\b(london|greater london)\b/i, bucket: 'london' },
  { pattern: /\bberlin\b/i, bucket: 'berlin' },
  { pattern: /\b(remote|anywhere|work from home|wfh)\b/i, bucket: 'remote' },
];

const TITLE_NOISE = [
  /\([^)]*\)/g, // parenthetical
  /\b(part[._-]?time|full[._-]?time|contract(?:or)?|intern(?:ship)?|consultant|freelance)\b/gi,
  /\b(senior|sr\.?|junior|jr\.?|principal|staff|lead|i+|iii|iv|v)\b/g, // strip levels for stable bucketing
  /[^\p{L}\p{N}\s]/gu, // punctuation
];

function normalizeTitle(title: string): string {
  let t = title.toLowerCase();
  for (const re of TITLE_NOISE) t = t.replace(re, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

function normalizeEmployer(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(inc\.?|ltd\.?|llc|llp|pvt\.?|private|limited|gmbh|sa|ag|corp\.?|co\.?)\b/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bucketLocation(loc: string | null): string {
  if (!loc) return 'unknown';
  for (const { pattern, bucket } of LOCATION_BUCKETS) {
    if (pattern.test(loc)) return bucket;
  }
  // Fallback: first 12 chars of normalized.
  return loc
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, '-')
    .slice(0, 16) || 'unknown';
}

export function buildCanonicalKey(input: {
  company: string | null;
  title: string;
  location: string | null;
}): string {
  const employer = input.company ? normalizeEmployer(input.company) : 'unknown';
  const title = normalizeTitle(input.title);
  const bucket = bucketLocation(input.location);
  if (employer === 'unknown' || title.length === 0) return '';
  return `${employer}::${title}::${bucket}`;
}
