// Q&A memory: question normalization (deterministic, model-free fallback) and
// the memory-first lookup decision that gives answers their cross-application
// consistency. Pure; the DB lookup is performed by ai-service against this logic.
//
// Reference: docs/architecture/07-ai-engine.md §6.2, §9.

/**
 * Deterministic question normalization used as the `qa_memory.question_norm`
 * lookup key. This is the model-free canonicalizer; the `qa.normalize` prompt is
 * only consulted for genuinely ambiguous phrasing. Lowercase, strip punctuation,
 * collapse whitespace, drop a leading politeness/filler, and trim a trailing
 * unit hint in parentheses so "Notice period (in days)?" == "notice period".
 */
export function normalizeQuestion(raw: string): string {
  let s = raw.toLowerCase().trim();
  s = s.replace(/\([^)]*\)/g, ' '); // drop parenthetical hints
  s = s.replace(/[^a-z0-9\s]/g, ' '); // strip punctuation
  // Drop leading politeness/filler and common interrogative + possessive/article
  // stopwords so phrasing variants collapse to the same key.
  s = s.replace(
    /\b(please|kindly|could you|can you|what is|what are|whats|tell us|tell me|your|the|a|an|do you|are you|how many|in)\b/g,
    ' ',
  );
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

export interface MemoryRow {
  id: string;
  questionNorm: string;
  answer: string | number | boolean;
  usedCount: number;
  /** When true, the user has locked this answer — AI never rewrites it (§9). */
  isLocked: boolean;
  /** Audit D3: answers derived from injection-suspected postings are quarantined. */
  quarantined?: boolean | undefined;
}

export type MemoryLookup =
  | { hit: true; row: MemoryRow; reason: 'exact' | 'locked' }
  | { hit: false; reason: 'no-match' | 'unused' | 'quarantined' };

/**
 * Memory-first lookup. An exact `question_norm` match that is non-quarantined and
 * has been used at least once (or is locked) returns deterministically — the
 * model is never called. This is the consistency guarantee (§9).
 */
export function lookupMemory(questionNorm: string, rows: MemoryRow[]): MemoryLookup {
  const matches = rows.filter((r) => r.questionNorm === questionNorm);
  if (matches.length === 0) return { hit: false, reason: 'no-match' };

  // Locked answers always win, even at used_count 0 (the user set them).
  const locked = matches.find((m) => m.isLocked && m.quarantined !== true);
  if (locked) return { hit: true, row: locked, reason: 'locked' };

  const usable = matches.find((m) => m.quarantined !== true && m.usedCount >= 1);
  if (usable) return { hit: true, row: usable, reason: 'exact' };

  if (matches.every((m) => m.quarantined === true)) return { hit: false, reason: 'quarantined' };
  return { hit: false, reason: 'unused' };
}

/**
 * Decide whether a freshly AI-generated answer may be auto-promoted to qa_memory.
 * Audit D3: when the source posting is flagged prompt_injection_suspected, the
 * answer is written quarantined and requires explicit user approval before reuse.
 */
export function promotionDecision(input: {
  confidence: number;
  promptInjectionSuspected: boolean;
  minConfidence?: number;
}): { promote: boolean; quarantined: boolean; reason: string } {
  const minConfidence = input.minConfidence ?? 0.6;
  if (input.confidence < minConfidence) {
    return { promote: false, quarantined: false, reason: 'low-confidence' };
  }
  if (input.promptInjectionSuspected) {
    return { promote: true, quarantined: true, reason: 'injection-suspected-quarantine' };
  }
  return { promote: true, quarantined: false, reason: 'ok' };
}
