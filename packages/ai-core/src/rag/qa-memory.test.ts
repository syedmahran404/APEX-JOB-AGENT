import { describe, it, expect } from 'vitest';
import { normalizeQuestion, lookupMemory, promotionDecision, type MemoryRow } from './qa-memory.js';

describe('rag/qa-memory normalizeQuestion', () => {
  it('canonicalizes phrasing variants to the same key', () => {
    const a = normalizeQuestion('What is your notice period?');
    const b = normalizeQuestion('Notice period');
    expect(a).toBe(b);
    expect(a).toBe('notice period');
  });
  it('strips politeness, possessives, and punctuation', () => {
    expect(normalizeQuestion('Please tell us: are you willing to relocate?')).toBe('willing to relocate');
    expect(normalizeQuestion('Willing to relocate')).toBe('willing to relocate');
  });
});

describe('rag/qa-memory lookupMemory (memory-first consistency)', () => {
  const rows: MemoryRow[] = [
    { id: '1', questionNorm: 'notice period', answer: 30, usedCount: 3, isLocked: false },
    { id: '2', questionNorm: 'willing to relocate', answer: 'Yes', usedCount: 0, isLocked: true },
    { id: '3', questionNorm: 'expected salary', answer: 100, usedCount: 5, isLocked: false, quarantined: true },
  ];

  it('returns an exact used answer (no model call)', () => {
    const r = lookupMemory('notice period', rows);
    expect(r.hit).toBe(true);
    if (r.hit) expect(r.row.answer).toBe(30);
  });

  it('returns a locked answer even at used_count 0', () => {
    const r = lookupMemory('willing to relocate', rows);
    expect(r.hit).toBe(true);
    if (r.hit) expect(r.reason).toBe('locked');
  });

  it('does NOT return a quarantined answer (injection guard)', () => {
    const r = lookupMemory('expected salary', rows);
    expect(r.hit).toBe(false);
    if (!r.hit) expect(r.reason).toBe('quarantined');
  });

  it('misses on unknown question', () => {
    expect(lookupMemory('favorite color', rows).hit).toBe(false);
  });

  it('reports unused when the only match has used_count 0 and is unlocked', () => {
    const r = lookupMemory('q', [{ id: 'x', questionNorm: 'q', answer: 'a', usedCount: 0, isLocked: false }]);
    expect(r.hit).toBe(false);
    if (!r.hit) expect(r.reason).toBe('unused');
  });
});

describe('rag/qa-memory promotionDecision (audit D3 quarantine)', () => {
  it('does not promote low-confidence answers', () => {
    expect(promotionDecision({ confidence: 0.4, promptInjectionSuspected: false }).promote).toBe(false);
  });
  it('promotes high-confidence clean answers', () => {
    const d = promotionDecision({ confidence: 0.9, promptInjectionSuspected: false });
    expect(d.promote).toBe(true);
    expect(d.quarantined).toBe(false);
  });
  it('promotes but QUARANTINES answers from injection-suspected postings', () => {
    const d = promotionDecision({ confidence: 0.9, promptInjectionSuspected: true });
    expect(d.promote).toBe(true);
    expect(d.quarantined).toBe(true);
    expect(d.reason).toMatch(/quarantine/);
  });
});
