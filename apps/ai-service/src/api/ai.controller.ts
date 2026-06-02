// AI gateway HTTP API. Each endpoint assembles the prompt messages, runs them
// through the AiGateway (governor → provider routing → schema validation →
// fallback → audit), then applies the matching ai-core safety guard before
// returning. Untrusted text (job descriptions, question text) is wrapped +
// injection-assessed; AI answers from injection-suspected sources are flagged so
// the caller quarantines them (audit D3).
//
// Reference: docs/architecture/07-ai-engine.md §5, §11–§15.

import { Body, Controller, Inject, Post } from '@nestjs/common';
import {
  assessInjection,
  guardAppAnswer,
  guardCoverLetter,
  guardProfileReview,
  guardResumePatch,
  wrapUntrusted,
  type AppAnswerOutput,
  type ChatMessage,
  type JobScoreOutput,
  type ProfileReviewOutput,
  type ResumePatch,
} from '@apex/ai-core';
import type { AiGateway } from '../gateway/gateway.js';
import { ZodPipe } from './zod.pipe.js';
import {
  AnswerQuestionRequest,
  ReviewProfileRequest,
  ScoreJobsRequest,
  TailorResumeRequest,
} from './dto.js';

export const AI_GATEWAY = Symbol('AI_GATEWAY');

@Controller('ai')
export class AiController {
  constructor(@Inject(AI_GATEWAY) private readonly gateway: AiGateway) {}

  @Post('score-jobs')
  async scoreJobs(@Body(new ZodPipe(ScoreJobsRequest)) body: ScoreJobsRequest): Promise<unknown> {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: JSON.stringify({
          profile: body.profile,
          jobs: body.jobs.map((j) => ({
            jobId: j.jobId,
            title: j.title,
            company: j.company,
            location: j.location,
            // Job description is untrusted → wrapped.
            description: wrapUntrusted(j.description),
          })),
        }),
      },
    ];
    const result = await this.gateway.run<JobScoreOutput>({
      promptKey: 'job.relevance.score',
      userId: body.userId,
      scopeKind: 'user',
      scopeId: body.userId,
      inputs: { jobIds: body.jobs.map((j) => j.jobId), profile: body.profile },
      messages,
      traceId: body.traceId,
    });
    return this.envelope(result);
  }

  @Post('answer')
  async answer(@Body(new ZodPipe(AnswerQuestionRequest)) body: AnswerQuestionRequest): Promise<unknown> {
    const injection = body.jobContext ? assessInjection(body.jobContext) : { suspected: false, signals: [], score: 0 };
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: JSON.stringify({
          question: wrapUntrusted(body.question),
          fieldKind: body.fieldKind,
          options: body.options,
          jobContext: body.jobContext ? wrapUntrusted(body.jobContext) : undefined,
          profileFacts: body.profileFacts,
        }),
      },
    ];
    const result = await this.gateway.run<AppAnswerOutput>({
      promptKey: 'app.answer',
      userId: body.userId,
      scopeKind: 'application',
      scopeId: body.applicationId,
      inputs: { fieldKind: body.fieldKind, options: body.options, profileFacts: body.profileFacts },
      messages,
      traceId: body.traceId,
    });
    if (!result.ok) return this.envelope(result);

    // Post-validation safety: low confidence yields to a human.
    const guarded = guardAppAnswer({ answer: result.value });
    if (guarded.decision === 'human-required') {
      return { ok: true, outcome: 'human_required', reason: guarded.reason, decisionId: result.decision.occurredAt };
    }
    return {
      ok: true,
      outcome: 'answered',
      answer: guarded.answer,
      // audit D3: caller must quarantine memory promotion when suspected.
      promptInjectionSuspected: injection.suspected,
      cost: result.decision.costUsd,
    };
  }

  @Post('tailor-resume')
  async tailorResume(@Body(new ZodPipe(TailorResumeRequest)) body: TailorResumeRequest): Promise<unknown> {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: JSON.stringify({
          basedOnVersionId: body.resumeVersionId,
          basis: body.basis,
          jobDescription: wrapUntrusted(body.jobDescription),
          evidenceItemIds: body.evidenceItemIds,
        }),
      },
    ];
    const result = await this.gateway.run<ResumePatch>({
      promptKey: 'resume.tailor',
      userId: body.userId,
      scopeKind: 'resume',
      scopeId: body.resumeVersionId,
      inputs: { resumeVersionId: body.resumeVersionId, evidenceItemIds: body.evidenceItemIds },
      messages,
      nonEssential: true,
      traceId: body.traceId,
    });
    if (!result.ok) return this.envelope(result);

    // Post-validation safety: drop fabricated metrics / uncited skills.
    const basisItems: Record<string, string> = {};
    for (const s of body.basis.sections) for (const it of s.items) basisItems[it.id] = it.text;
    const guarded = guardResumePatch({
      patch: result.value,
      basisItems,
      evidenceIds: new Set(body.evidenceItemIds),
    });
    return {
      ok: true,
      outcome: 'patch',
      ops: guarded.ops,
      droppedViolations: guarded.violations,
      cost: result.decision.costUsd,
    };
  }

  @Post('review-profile')
  async reviewProfile(@Body(new ZodPipe(ReviewProfileRequest)) body: ReviewProfileRequest): Promise<unknown> {
    const messages: ChatMessage[] = [{ role: 'user', content: JSON.stringify(body.profile) }];
    const result = await this.gateway.run<ProfileReviewOutput>({
      promptKey: 'profile.review',
      userId: body.userId,
      scopeKind: 'user',
      scopeId: body.userId,
      inputs: { skills: body.profile.skills },
      messages,
      nonEssential: true,
      traceId: body.traceId,
    });
    if (!result.ok) return this.envelope(result);

    const knownTokens = new Set<string>(
      [...body.profile.skills, ...body.profile.experience.map((e) => e.text)]
        .join(' ')
        .toLowerCase()
        .match(/[a-z0-9+#.]{2,}/g) ?? [],
    );
    const guarded = guardProfileReview({ review: result.value, knownTokens });
    return {
      ok: true,
      outcome: 'suggestions',
      suggestions: guarded.suggestions,
      droppedViolations: guarded.violations,
      cost: result.decision.costUsd,
    };
  }

  /** Shape a gateway result (skip/validation-failed) into an HTTP envelope. */
  private envelope(result: { ok: boolean; reason?: string; detail?: string; value?: unknown }): unknown {
    if (result.ok) return { ok: true, value: result.value };
    return { ok: false, reason: result.reason, detail: result.detail };
  }
}

// guardCoverLetter is exported by ai-core and used by the cover-letter flow
// (wired in the worker's apply path); referenced here to keep the safety surface
// discoverable from the gateway module.
export const SAFETY_GUARDS = { guardCoverLetter };
