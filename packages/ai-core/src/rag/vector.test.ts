import { describe, it, expect } from 'vitest';
import { cosineSimilarity, trigramSimilarity, hybridSearch, type Candidate } from './vector.js';

describe('rag/vector', () => {
  it('cosineSimilarity: identical=1, orthogonal=0, length-mismatch=0', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 5);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });

  it('trigramSimilarity: identical strings high, unrelated low', () => {
    expect(trigramSimilarity('notice period', 'notice period')).toBeCloseTo(1, 5);
    expect(trigramSimilarity('notice period', 'favorite color')).toBeLessThan(0.2);
  });

  describe('hybridSearch', () => {
    const candidates: Candidate[] = [
      { id: 'a', text: 'what is your notice period', embedding: [1, 0, 0] },
      { id: 'b', text: 'are you willing to relocate', embedding: [0, 1, 0] },
      { id: 'c', text: 'notice period in days', embedding: [0.9, 0.1, 0] },
    ];

    it('ranks the lexically + semantically closest first', () => {
      const ranked = hybridSearch('notice period days', [1, 0, 0], candidates);
      expect(ranked[0]?.id).toBeDefined();
      expect(['a', 'c']).toContain(ranked[0]?.id);
      expect(ranked.length).toBeLessThanOrEqual(5);
    });

    it('respects topK', () => {
      const ranked = hybridSearch('q', null, candidates, { topK: 1 });
      expect(ranked).toHaveLength(1);
    });

    it('combines weights: pure-lexical when no embedding supplied', () => {
      const ranked = hybridSearch('notice period', null, candidates, { lexWeight: 1, semWeight: 0 });
      expect(ranked[0]?.semScore).toBe(0);
      expect(ranked[0]?.lexScore).toBeGreaterThan(0);
    });

    it('is deterministic (id tiebreak)', () => {
      const r1 = hybridSearch('zzz', null, candidates).map((c) => c.id);
      const r2 = hybridSearch('zzz', null, candidates).map((c) => c.id);
      expect(r1).toEqual(r2);
    });
  });
});
