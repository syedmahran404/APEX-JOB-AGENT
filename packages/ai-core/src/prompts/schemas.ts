// Output Zod schemas for every prompt. These are the contract the model MUST
// satisfy before any state mutation. DB column types depend on these (e.g.
// applications.ai_score is SMALLINT → score is z.number().int().min(0).max(100)).
//
// Reference: docs/architecture/07-ai-engine.md §5, §11–§14.

import { z } from 'zod';

// ---- job.relevance.score ----
export const SalaryFit = z.enum(['over', 'within', 'under', 'unknown']);
export const LocationFit = z.enum(['good', 'okay', 'mismatch']);

export const JobScoreResult = z.object({
  jobId: z.string().min(1),
  score: z.number().int().min(0).max(100),
  drivers: z.object({
    matchedSkills: z.array(z.string()),
    salaryFit: SalaryFit,
    locationFit: LocationFit,
    titleAlignment: z.number().min(0).max(1),
  }),
  reasoning: z.string().min(1),
  risks: z.array(z.string()),
});
export const JobScoreOutput = z.object({ results: z.array(JobScoreResult) });
export type JobScoreOutput = z.infer<typeof JobScoreOutput>;

// ---- app.answer ----
export const AppAnswerOutput = z.object({
  /** Answer value; string | number | boolean depending on fieldKind. */
  answer: z.union([z.string(), z.number(), z.boolean()]),
  /** 0..1 model confidence; low confidence triggers human-required. */
  confidence: z.number().min(0).max(1),
  /** One-sentence rationale (audited, not shown raw to employers). */
  rationale: z.string(),
});
export type AppAnswerOutput = z.infer<typeof AppAnswerOutput>;

// ---- resume.tailor (PATCH-only; never a freeform replace) ----
export const ResumeOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('reorder'), section: z.string(), ids: z.array(z.string()) }),
  z.object({ op: z.literal('reword'), sectionItemId: z.string(), proposedText: z.string(), rationale: z.string() }),
  z.object({ op: z.literal('highlight'), sectionItemId: z.string() }),
  z.object({ op: z.literal('add_skill'), skillName: z.string(), evidenceItemIds: z.array(z.string()) }),
  z.object({ op: z.literal('reorder_skills'), proposed: z.array(z.string()) }),
]);
export type ResumeOp = z.infer<typeof ResumeOp>;

export const ResumePatch = z.object({
  basedOnVersionId: z.string().min(1),
  reasoning: z.string(),
  ops: z.array(ResumeOp),
});
export type ResumePatch = z.infer<typeof ResumePatch>;

// ---- cover.letter (free text body + structural metadata) ----
export const CoverLetterOutput = z.object({
  body: z.string().min(1),
  tone: z.enum(['professional', 'enthusiastic', 'concise']),
});
export type CoverLetterOutput = z.infer<typeof CoverLetterOutput>;

// ---- profile.review ----
export const ProfileSuggestion = z.object({
  id: z.string().min(1),
  area: z.enum(['headline', 'summary', 'skills', 'experience', 'projects', 'links']),
  issue: z.string(),
  expectedBenefit: z.string(),
  current: z.string(),
  proposed: z.string(),
  confidence: z.number().min(0).max(1),
  references: z.array(z.string()).optional(),
});
export type ProfileSuggestion = z.infer<typeof ProfileSuggestion>;
export const ProfileReviewOutput = z.object({ suggestions: z.array(ProfileSuggestion) });
export type ProfileReviewOutput = z.infer<typeof ProfileReviewOutput>;

// ---- captcha.classify (support) ----
export const CaptchaClassifyOutput = z.object({
  kind: z.enum(['captcha', 'otp', 'phone', 'email', 'security', 'none']),
  confidence: z.number().min(0).max(1),
});
export type CaptchaClassifyOutput = z.infer<typeof CaptchaClassifyOutput>;

// ---- qa.normalize (support) ----
export const QaNormalizeOutput = z.object({
  questionNorm: z.string().min(1),
});
export type QaNormalizeOutput = z.infer<typeof QaNormalizeOutput>;
