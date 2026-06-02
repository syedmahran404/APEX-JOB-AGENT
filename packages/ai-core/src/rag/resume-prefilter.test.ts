import { describe, it, expect } from 'vitest';
import { prefilterSections, type ResumeSection } from './resume-prefilter.js';

const sections: ResumeSection[] = [
  { id: 's-sum', kind: 'summary', text: 'summary', embedding: [0, 0, 1] },
  { id: 's-skill', kind: 'skills', text: 'skills', embedding: [0, 0, 1] },
  { id: 'e1', kind: 'experience', text: 'backend node postgres', embedding: [1, 0, 0] },
  { id: 'e2', kind: 'experience', text: 'frontend react', embedding: [0, 1, 0] },
  { id: 'p1', kind: 'projects', text: 'data pipeline', embedding: [0.9, 0.1, 0] },
];

describe('rag/resume-prefilter (audit D5)', () => {
  it('always includes summary + skills regardless of relevance', () => {
    const res = prefilterSections([1, 0, 0], sections, { topK: 3 });
    const ids = res.included.map((s) => s.id);
    expect(ids).toContain('s-sum');
    expect(ids).toContain('s-skill');
  });

  it('includes the most JD-relevant experience/projects in remaining slots', () => {
    const res = prefilterSections([1, 0, 0], sections, { topK: 4 });
    const ids = res.included.map((s) => s.id);
    // JD ~ [1,0,0] → e1 and p1 are closest.
    expect(ids).toContain('e1');
    expect(ids).not.toContain('e2'); // least relevant, dropped to passthrough
  });

  it('passthrough holds the sections not included (untouched by ops)', () => {
    const res = prefilterSections([1, 0, 0], sections, { topK: 3, alwaysInclude: ['summary', 'skills'] });
    const all = [...res.included, ...res.passthrough].map((s) => s.id).sort();
    expect(all).toEqual(sections.map((s) => s.id).sort());
  });

  it('honors topK budget', () => {
    const res = prefilterSections([1, 0, 0], sections, { topK: 2, alwaysInclude: [] });
    expect(res.included.length).toBeLessThanOrEqual(2);
  });
});
