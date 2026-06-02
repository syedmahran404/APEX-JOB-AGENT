import { describe, it, expect } from 'vitest';
import {
  guardResumePatch,
  guardCoverLetter,
  guardAppAnswer,
  guardProfileReview,
} from './guards.js';
import type { ResumePatch, CoverLetterOutput, AppAnswerOutput, ProfileReviewOutput } from '../prompts/schemas.js';

describe('safety/guards guardResumePatch (§13)', () => {
  const basisItems = { e1: 'Built APIs serving 10000 users', e2: 'Led the migration' };
  const evidenceIds = new Set(['e1', 'e2', 'p1']);

  it('drops a reword that introduces a new metric absent from the basis', () => {
    const patch: ResumePatch = {
      basedOnVersionId: 'v1',
      reasoning: 'x',
      ops: [{ op: 'reword', sectionItemId: 'e1', proposedText: 'Built APIs serving 99% of 50000 users', rationale: 'r' }],
    };
    const res = guardResumePatch({ patch, basisItems, evidenceIds });
    expect(res.ops).toHaveLength(0);
    expect(res.violations[0]?.rule).toBe('reword.introduced-metric');
  });

  it('keeps a reword that reuses existing metrics', () => {
    const patch: ResumePatch = {
      basedOnVersionId: 'v1',
      reasoning: 'x',
      ops: [{ op: 'reword', sectionItemId: 'e1', proposedText: 'Engineered APIs for 10000 users', rationale: 'r' }],
    };
    const res = guardResumePatch({ patch, basisItems, evidenceIds });
    expect(res.ops).toHaveLength(1);
  });

  it('drops an add_skill with no evidence citation', () => {
    const patch: ResumePatch = {
      basedOnVersionId: 'v1',
      reasoning: 'x',
      ops: [{ op: 'add_skill', skillName: 'Rust', evidenceItemIds: ['nonexistent'] }],
    };
    const res = guardResumePatch({ patch, basisItems, evidenceIds });
    expect(res.ops).toHaveLength(0);
    expect(res.violations[0]?.rule).toBe('add_skill.no-evidence');
  });

  it('keeps an add_skill citing real evidence', () => {
    const patch: ResumePatch = {
      basedOnVersionId: 'v1',
      reasoning: 'x',
      ops: [{ op: 'add_skill', skillName: 'PostgreSQL', evidenceItemIds: ['e1'] }],
    };
    expect(guardResumePatch({ patch, basisItems, evidenceIds }).ops).toHaveLength(1);
  });

  it('caps ops at maxOps', () => {
    const ops = Array.from({ length: 15 }, () => ({ op: 'highlight' as const, sectionItemId: 'e1' }));
    const patch: ResumePatch = { basedOnVersionId: 'v1', reasoning: 'x', ops };
    const res = guardResumePatch({ patch, basisItems, evidenceIds, maxOps: 5 });
    expect(res.ops).toHaveLength(5);
    expect(res.violations.some((v) => v.rule === 'ops.too-many')).toBe(true);
  });
});

describe('safety/guards guardCoverLetter (§12)', () => {
  const good =
    'I was glad to see your opening for a backend engineer at Acme, a team known for taking ' +
    'reliability seriously. The role lines up closely with the kind of work I have spent the ' +
    'last few years doing, and I would be glad to contribute from day one.\n\n' +
    'In my most recent position I designed and operated Node.js services backed by PostgreSQL ' +
    'that stayed healthy under heavy and uneven traffic. I cared about clear failure handling, ' +
    'careful migrations, and observability so that incidents could be understood quickly rather ' +
    'than guessed at. That steady, methodical approach to building systems is exactly what I read ' +
    'into your description, and it is how I prefer to work.\n\n' +
    'I would welcome the chance to talk through how I can help your roadmap and where I could make ' +
    'an early difference. You can reach me at the profile link attached to this application, and I ' +
    'am happy to walk through any of the projects in more detail whenever it is convenient.';

  it('passes a well-formed letter', () => {
    const letter: CoverLetterOutput = { body: good, tone: 'professional' };
    const res = guardCoverLetter({ letter, jobMentionsComp: false });
    expect(res.ok).toBe(true);
  });

  it('flags banned clichés', () => {
    const letter: CoverLetterOutput = { body: good + '\n\nI am a rockstar ninja.', tone: 'enthusiastic' };
    const res = guardCoverLetter({ letter, jobMentionsComp: false });
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.rule === 'banned-phrase')).toBe(true);
  });

  it('flags unsolicited compensation mention', () => {
    const letter: CoverLetterOutput = { body: good + '\n\nMy salary expectation is $200000.', tone: 'concise' };
    const res = guardCoverLetter({ letter, jobMentionsComp: false });
    expect(res.violations.some((v) => v.rule === 'compensation.unsolicited')).toBe(true);
  });

  it('allows compensation mention when the JD itself mentions it', () => {
    const letter: CoverLetterOutput = { body: good + '\n\nMy salary expectation aligns with the posted range.', tone: 'concise' };
    const res = guardCoverLetter({ letter, jobMentionsComp: true });
    expect(res.violations.some((v) => v.rule === 'compensation.unsolicited')).toBe(false);
  });

  it('flags first-person plural', () => {
    const letter: CoverLetterOutput = { body: good + '\n\nWe are a great fit and our skills align.', tone: 'professional' };
    const res = guardCoverLetter({ letter, jobMentionsComp: false });
    expect(res.violations.some((v) => v.rule === 'first-person-plural')).toBe(true);
  });

  it('flags too-short bodies', () => {
    const letter: CoverLetterOutput = { body: 'Too short.', tone: 'concise' };
    expect(guardCoverLetter({ letter, jobMentionsComp: false }).ok).toBe(false);
  });
});

describe('safety/guards guardAppAnswer (§5)', () => {
  it('uses a confident answer', () => {
    const answer: AppAnswerOutput = { answer: 30, confidence: 0.9, rationale: 'r' };
    const res = guardAppAnswer({ answer });
    expect(res.decision).toBe('use');
  });
  it('yields to human on low confidence', () => {
    const answer: AppAnswerOutput = { answer: 'maybe', confidence: 0.3, rationale: 'r' };
    const res = guardAppAnswer({ answer });
    expect(res.decision).toBe('human-required');
    if (res.decision === 'human-required') expect(res.reason).toBe('policy:low-confidence');
  });
});

describe('safety/guards guardProfileReview (§11 no fabrication)', () => {
  const known = new Set(['node', 'postgresql', 'acme']);

  it('drops suggestions below 0.6 confidence', () => {
    const review: ProfileReviewOutput = {
      suggestions: [{ id: '1', area: 'summary', issue: 'i', expectedBenefit: 'b', current: 'c', proposed: 'p', confidence: 0.4 }],
    };
    const res = guardProfileReview({ review, knownTokens: known });
    expect(res.suggestions).toHaveLength(0);
    expect(res.violations[0]?.rule).toBe('confidence.too-low');
  });

  it('drops a skills suggestion that fabricates an unknown skill', () => {
    const review: ProfileReviewOutput = {
      suggestions: [{ id: '2', area: 'skills', issue: 'i', expectedBenefit: 'b', current: 'Node', proposed: 'Add Kubernetes and Terraform', confidence: 0.9 }],
    };
    const res = guardProfileReview({ review, knownTokens: known });
    expect(res.suggestions).toHaveLength(0);
    expect(res.violations[0]?.rule).toBe('fabrication.unknown-token');
  });

  it('keeps a high-confidence non-fabricating suggestion', () => {
    const review: ProfileReviewOutput = {
      suggestions: [{ id: '3', area: 'summary', issue: 'too long', expectedBenefit: 'clarity', current: 'long', proposed: 'short crisp summary', confidence: 0.8 }],
    };
    const res = guardProfileReview({ review, knownTokens: known });
    expect(res.suggestions).toHaveLength(1);
  });
});
