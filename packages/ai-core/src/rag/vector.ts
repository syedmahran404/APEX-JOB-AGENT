// Vector math + hybrid retrieval merge. Pure functions; the actual pgvector ANN
// query is performed by ai-service, but ranking/merging logic lives here so it
// is deterministic and unit-testable.
//
// Reference: docs/architecture/07-ai-engine.md §6.2, §6.3.

/** Cosine similarity of two equal-length vectors. Returns 0 on length mismatch. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Trigram set of a string (for lexical similarity), lowercased + space-padded. */
export function trigrams(s: string): Set<string> {
  const norm = ` ${s.toLowerCase().replace(/\s+/g, ' ').trim()} `;
  const grams = new Set<string>();
  for (let i = 0; i < norm.length - 2; i++) grams.add(norm.slice(i, i + 3));
  return grams;
}

/** Jaccard trigram similarity in [0, 1] (pg_trgm-style lexical score). */
export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 && tb.size === 0) return 0;
  let inter = 0;
  for (const g of ta) if (tb.has(g)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface Candidate {
  id: string;
  /** The text used for lexical comparison (e.g. question_norm). */
  text: string;
  /** Precomputed embedding for semantic comparison (optional). */
  embedding?: number[] | undefined;
}

export interface RankedCandidate extends Candidate {
  lexScore: number;
  semScore: number;
  score: number;
}

export interface HybridSearchOptions {
  /** Lexical weight (default 0.4). */
  lexWeight?: number;
  /** Semantic weight (default 0.6). */
  semWeight?: number;
  /** Keep top-k after merge (default 5). */
  topK?: number;
}

/**
 * Hybrid lexical + semantic merge: `score = lexW*lex + semW*sem`, sorted desc,
 * ties broken by id for determinism. Mirrors the pipeline in §6.2 step 3.
 */
export function hybridSearch(
  queryText: string,
  queryEmbedding: number[] | null,
  candidates: Candidate[],
  opts: HybridSearchOptions = {},
): RankedCandidate[] {
  const lexW = opts.lexWeight ?? 0.4;
  const semW = opts.semWeight ?? 0.6;
  const topK = opts.topK ?? 5;

  const ranked: RankedCandidate[] = candidates.map((c) => {
    const lexScore = trigramSimilarity(queryText, c.text);
    const semScore = queryEmbedding && c.embedding ? Math.max(0, cosineSimilarity(queryEmbedding, c.embedding)) : 0;
    return { ...c, lexScore, semScore, score: lexW * lexScore + semW * semScore };
  });

  return ranked
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id.localeCompare(b.id)))
    .slice(0, topK);
}
