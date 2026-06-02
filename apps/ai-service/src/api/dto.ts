// Request DTOs for the AI gateway HTTP API. Validated with Zod at the boundary
// (the gateway then validates the model OUTPUT against the prompt schema).

import { z } from 'zod';

const userScope = {
  userId: z.string().uuid(),
  traceId: z.string().optional(),
};

export const ScoreJobsRequest = z.object({
  ...userScope,
  jobs: z
    .array(
      z.object({
        jobId: z.string().min(1),
        title: z.string().min(1),
        company: z.string().min(1),
        description: z.string().min(1),
        location: z.string().optional(),
        salaryText: z.string().optional(),
      }),
    )
    .min(1)
    .max(25),
  /** Compact profile context (skills + headline) — caller pre-redacts PII. */
  profile: z.object({
    headline: z.string(),
    skills: z.array(z.string()),
    yearsExperience: z.number().nonnegative().optional(),
  }),
});
export type ScoreJobsRequest = z.infer<typeof ScoreJobsRequest>;

export const AnswerQuestionRequest = z.object({
  ...userScope,
  applicationId: z.string().uuid(),
  question: z.string().min(1),
  fieldKind: z.enum(['text', 'number', 'select', 'radio', 'checkbox', 'date']),
  options: z.array(z.string()).optional(),
  /** Untrusted job-posting context (wrapped + injection-checked by the gateway). */
  jobContext: z.string().optional(),
  profileFacts: z.record(z.string(), z.string()).default({}),
});
export type AnswerQuestionRequest = z.infer<typeof AnswerQuestionRequest>;

export const TailorResumeRequest = z.object({
  ...userScope,
  resumeVersionId: z.string().uuid(),
  basis: z.object({
    sections: z.array(
      z.object({ id: z.string(), kind: z.string(), items: z.array(z.object({ id: z.string(), text: z.string() })) }),
    ),
  }),
  jobDescription: z.string().min(1),
  evidenceItemIds: z.array(z.string()).default([]),
});
export type TailorResumeRequest = z.infer<typeof TailorResumeRequest>;

export const ReviewProfileRequest = z.object({
  ...userScope,
  profile: z.object({
    headline: z.string(),
    summary: z.string(),
    skills: z.array(z.string()),
    experience: z.array(z.object({ id: z.string(), text: z.string() })),
  }),
});
export type ReviewProfileRequest = z.infer<typeof ReviewProfileRequest>;
