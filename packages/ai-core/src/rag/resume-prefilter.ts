// Resume section pre-filter (audit D5). For long resumes, only the top-K
// sections most relevant to the job description enter the resume.tailor prompt;
// the rest pass through untouched. This keeps the prompt small and the patch
// focused. Pure; embeddings are supplied by the caller.
//
// Reference: docs/audit/01-architecture-validation.md D5; 07-ai-engine.md §13.

import { cosineSimilarity } from './vector.js';

export interface ResumeSection {
  id: string;
  /** e.g. 'experience', 'projects', 'summary'. */
  kind: string;
  text: string;
  embedding?: number[] | undefined;
}

export interface PrefilterOptions {
  /** Max sections to include in the prompt (default 6). */
  topK?: number;
  /** Always-include section kinds regardless of score (e.g. summary, skills). */
  alwaysInclude?: string[];
  /** Minimum cosine to be considered relevant (default 0). */
  minScore?: number;
}

export interface PrefilterResult {
  included: ResumeSection[];
  passthrough: ResumeSection[];
}

/**
 * Select the sections that enter the tailor prompt. `alwaysInclude` kinds are
 * kept unconditionally; the remainder are ranked by cosine vs the JD embedding
 * and the top-K are included. Everything else is passthrough (untouched by ops).
 */
export function prefilterSections(
  jobEmbedding: number[],
  sections: ResumeSection[],
  opts: PrefilterOptions = {},
): PrefilterResult {
  const topK = opts.topK ?? 6;
  const minScore = opts.minScore ?? 0;
  const always = new Set(opts.alwaysInclude ?? ['summary', 'skills']);

  const forced = sections.filter((s) => always.has(s.kind));
  const scorable = sections.filter((s) => !always.has(s.kind));

  const ranked = scorable
    .map((s) => ({ s, score: s.embedding ? cosineSimilarity(jobEmbedding, s.embedding) : 0 }))
    .filter((r) => r.score >= minScore)
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.s.id.localeCompare(b.s.id)));

  const remainingSlots = Math.max(0, topK - forced.length);
  const topScored = ranked.slice(0, remainingSlots).map((r) => r.s);
  const includedIds = new Set([...forced, ...topScored].map((s) => s.id));

  return {
    included: sections.filter((s) => includedIds.has(s.id)),
    passthrough: sections.filter((s) => !includedIds.has(s.id)),
  };
}
