// Banned clichés for cover letters and prose outputs. Maintained here so prompts
// and the eval harness share one source of truth.
//
// Reference: docs/architecture/07-ai-engine.md §5, §12.

export const BANNED_PHRASES: string[] = [
  'rockstar',
  'ninja',
  'synergy',
  'synergies',
  'think outside the box',
  'hit the ground running',
  'go-getter',
  'team player',
  'results-driven',
  'detail-oriented',
  'self-starter',
  'passionate about',
  'wear many hats',
  'move the needle',
  'low-hanging fruit',
  'circle back',
  'best of breed',
  'game changer',
  'game-changer',
];

/** Return the banned phrases present in `text` (case-insensitive, word-ish). */
export function findBannedPhrases(text: string): string[] {
  const lower = text.toLowerCase();
  return BANNED_PHRASES.filter((p) => lower.includes(p));
}
