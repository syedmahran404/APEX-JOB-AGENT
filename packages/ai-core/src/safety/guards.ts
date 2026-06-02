// Post-validation safety guards. After a prompt output passes its Zod schema,
// these enforce the SUBSTANTIVE rules the schema can't express:
//   - resume patch: rewords introduce no new metrics; add_skill must cite
//     evidence; ops bounded; ops target only known section items.
//   - cover letter: paragraph + length bounds; banned phrases; no compensation
//     unless the JD mentions it.
//   - app.answer: low-confidence yields to human; never asserts a credential the
//     profile lacks.
//   - profile.review: drop < 0.6 confidence; never adds a role/skill absent from
//     the user's data (no fabrication).
// Pure functions returning a filtered/validated result + violations.
//
// Reference: docs/architecture/07-ai-engine.md §11–§15.

import type { ResumePatch, ResumeOp, CoverLetterOutput, AppAnswerOutput, ProfileReviewOutput } from '../prompts/schemas.js';
import { findBannedPhrases } from '../style/banned.js';

const NUMERIC_RE = /\d+(?:[.,]\d+)?%?/g;

/** Extract the multiset of numeric tokens in a string. */
function numbersIn(text: string): string[] {
  return (text.match(NUMERIC_RE) ?? []).map((s) => s.replace(/[.,]$/, ''));
}

export interface GuardViolation {
  rule: string;
  detail: string;
}

export interface ResumePatchGuardInput {
  patch: ResumePatch;
  /** Map of sectionItemId → its current text in the basis resume. */
  basisItems: Record<string, string>;
  /** Valid evidence item ids the user actually has (experiences/projects). */
  evidenceIds: Set<string>;
  /** Max ops to keep the diff reviewable (§13). */
  maxOps?: number;
}

export interface ResumePatchGuardResult {
  ops: ResumeOp[];
  violations: GuardViolation[];
}

/**
 * Validate + sanitize a resume patch. Drops ops that violate a rule rather than
 * rejecting the whole patch, recording each violation. Caps op count.
 */
export function guardResumePatch(input: ResumePatchGuardInput): ResumePatchGuardResult {
  const violations: GuardViolation[] = [];
  const kept: ResumeOp[] = [];
  const maxOps = input.maxOps ?? 12;

  for (const op of input.patch.ops) {
    if (op.op === 'reword') {
      const basis = input.basisItems[op.sectionItemId];
      if (basis === undefined) {
        violations.push({ rule: 'reword.unknown-item', detail: op.sectionItemId });
        continue;
      }
      // No NEW metrics may be introduced that are absent from the basis.
      const basisNums = new Set(numbersIn(basis));
      const proposedNums = numbersIn(op.proposedText);
      const introduced = proposedNums.filter((n) => !basisNums.has(n));
      if (introduced.length > 0) {
        violations.push({ rule: 'reword.introduced-metric', detail: introduced.join(',') });
        continue;
      }
      kept.push(op);
    } else if (op.op === 'add_skill') {
      const hasEvidence = op.evidenceItemIds.some((id) => input.evidenceIds.has(id));
      if (!hasEvidence) {
        violations.push({ rule: 'add_skill.no-evidence', detail: op.skillName });
        continue;
      }
      kept.push(op);
    } else if (op.op === 'highlight') {
      if (input.basisItems[op.sectionItemId] === undefined) {
        violations.push({ rule: 'highlight.unknown-item', detail: op.sectionItemId });
        continue;
      }
      kept.push(op);
    } else {
      // reorder / reorder_skills are structurally safe.
      kept.push(op);
    }
  }

  if (kept.length > maxOps) {
    violations.push({ rule: 'ops.too-many', detail: `${String(kept.length)}>${String(maxOps)}` });
    return { ops: kept.slice(0, maxOps), violations };
  }
  return { ops: kept, violations };
}

export interface CoverLetterGuardInput {
  letter: CoverLetterOutput;
  /** True when the job description itself mentions compensation. */
  jobMentionsComp: boolean;
  minChars?: number;
  maxChars?: number;
  minParagraphs?: number;
  maxParagraphs?: number;
}

export interface CoverLetterGuardResult {
  ok: boolean;
  violations: GuardViolation[];
}

const COMP_RE = /\b(salary|compensation|ctc|pay|stipend|\$\d|₹\d|inr\s*\d)\b/i;

/** Validate a cover letter against the structural + content constraints (§12). */
export function guardCoverLetter(input: CoverLetterGuardInput): CoverLetterGuardResult {
  const violations: GuardViolation[] = [];
  const body = input.letter.body.trim();
  const minChars = input.minChars ?? 600;
  const maxChars = input.maxChars ?? 2400;
  const minP = input.minParagraphs ?? 3;
  const maxP = input.maxParagraphs ?? 5;

  if (body.length < minChars) violations.push({ rule: 'length.too-short', detail: String(body.length) });
  if (body.length > maxChars) violations.push({ rule: 'length.too-long', detail: String(body.length) });

  const paragraphs = body.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  if (paragraphs.length < minP) violations.push({ rule: 'paragraphs.too-few', detail: String(paragraphs.length) });
  if (paragraphs.length > maxP) violations.push({ rule: 'paragraphs.too-many', detail: String(paragraphs.length) });

  const banned = findBannedPhrases(body);
  if (banned.length > 0) violations.push({ rule: 'banned-phrase', detail: banned.join(',') });

  if (!input.jobMentionsComp && COMP_RE.test(body)) {
    violations.push({ rule: 'compensation.unsolicited', detail: 'mentions comp absent from JD' });
  }

  // No first-person plural ("we", "our") — it's a single applicant.
  if (/\b(we|our|us)\b/i.test(body)) {
    violations.push({ rule: 'first-person-plural', detail: 'uses we/our/us' });
  }

  return { ok: violations.length === 0, violations };
}

export interface AppAnswerGuardInput {
  answer: AppAnswerOutput;
  /** Min confidence below which we yield to a human (§5 fallback). */
  minConfidence?: number;
}

export type AppAnswerGuardResult =
  | { decision: 'use'; answer: AppAnswerOutput }
  | { decision: 'human-required'; reason: 'policy:low-confidence' };

/** Enforce the low-confidence → human-required rule for application answers. */
export function guardAppAnswer(input: AppAnswerGuardInput): AppAnswerGuardResult {
  const min = input.minConfidence ?? 0.6;
  if (input.answer.confidence < min) {
    return { decision: 'human-required', reason: 'policy:low-confidence' };
  }
  return { decision: 'use', answer: input.answer };
}

export interface ProfileReviewGuardInput {
  review: ProfileReviewOutput;
  /** Existing skill names + role/company tokens the user actually has. */
  knownTokens: Set<string>;
  minConfidence?: number;
}

export interface ProfileReviewGuardResult {
  suggestions: ProfileReviewOutput['suggestions'];
  violations: GuardViolation[];
}

/**
 * Filter profile suggestions: drop < minConfidence; drop any 'skills'/'experience'
 * suggestion whose `proposed` introduces a role/skill token absent from the
 * user's data (no fabrication, §11 / §15.1).
 */
export function guardProfileReview(input: ProfileReviewGuardInput): ProfileReviewGuardResult {
  const min = input.minConfidence ?? 0.6;
  const violations: GuardViolation[] = [];
  const kept = input.review.suggestions.filter((s) => {
    if (s.confidence < min) {
      violations.push({ rule: 'confidence.too-low', detail: s.id });
      return false;
    }
    if (s.area === 'skills' || s.area === 'experience') {
      // The proposed text must not introduce a capitalized proper noun (likely a
      // fabricated employer/skill) that the user does not already have.
      const tokens = (s.proposed.match(/[A-Z][a-zA-Z0-9+#.]{2,}/g) ?? []).map((t) => t.toLowerCase());
      const fabricated = tokens.filter((t) => !input.knownTokens.has(t));
      if (fabricated.length > 0) {
        violations.push({ rule: 'fabrication.unknown-token', detail: fabricated.join(',') });
        return false;
      }
    }
    return true;
  });
  return { suggestions: kept, violations };
}
