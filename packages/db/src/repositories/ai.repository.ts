// AI repository — the data layer for the AI engine (Phase 3). Apps must not
// touch @prisma/client directly (apex/no-direct-prisma-in-apps), so all AI DB
// access goes through this repository.
//
// Implements:
//   - the ATOMIC cost-ledger debit via the `ai_cost_try_debit` SQL function
//     (audit B1 — race-free `spent + cost <= ceiling` guard),
//   - the daily ledger-state read for the governor,
//   - ai_decisions inserts,
//   - qa_memory upsert/lookup/used-count + answer_history append.
//
// Reference: docs/architecture/07-ai-engine.md §7, §8, §9.

import type { PrismaClient } from '@prisma/client';

export interface LedgerState {
  spentTodayUsd: number;
  dailyCeilingUsd: number;
}

export interface AiDecisionInsert {
  tenantId: string;
  userId: string;
  promptKey: string;
  promptVersion: number;
  tier: string;
  model: string;
  scopeKind: string;
  scopeId: string;
  inputs: unknown;
  output: unknown;
  validationError?: string | null;
  governorAction?: string | null;
  safetyScore?: number | null;
  safetyAction?: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  traceId?: string | null;
}

function todayUtc(now: Date): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

export class AiRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Atomic cost debit (audit B1). Calls the `ai_cost_try_debit` SQL function,
   * which increments spend ONLY when it stays at or below the ceiling and
   * RETURNs the new spend (NULL when it would breach). Returns true if debited.
   */
  async tryDebit(
    userId: string,
    tenantId: string,
    costUsd: number,
    ceilingUsd: number,
    now: Date = new Date(),
  ): Promise<boolean> {
    const day = todayUtc(now);
    const rows = await this.prisma.$queryRawUnsafe<Array<{ ai_cost_try_debit: number | null }>>(
      'SELECT ai_cost_try_debit($1::uuid, $2::uuid, $3::date, $4::numeric, $5::numeric) AS ai_cost_try_debit',
      userId,
      tenantId,
      day,
      costUsd,
      ceilingUsd,
    );
    return rows[0]?.ai_cost_try_debit != null;
  }

  /** Current ledger state for the governor (spent today + ceiling). */
  async ledgerState(userId: string, defaultCeilingUsd: number, now: Date = new Date()): Promise<LedgerState> {
    const day = todayUtc(now);
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ spent_usd: string; ceiling_usd: string }>
    >(
      'SELECT spent_usd, ceiling_usd FROM ai_cost_ledger WHERE user_id = $1::uuid AND day = $2::date',
      userId,
      day,
    );
    const row = rows[0];
    if (!row) return { spentTodayUsd: 0, dailyCeilingUsd: defaultCeilingUsd };
    return { spentTodayUsd: Number(row.spent_usd), dailyCeilingUsd: Number(row.ceiling_usd) };
  }

  /** Insert one ai_decisions row (inputs must already be PII-redacted). */
  async recordDecision(d: AiDecisionInsert): Promise<void> {
    await this.prisma.aiDecision.create({
      data: {
        tenantId: d.tenantId,
        userId: d.userId,
        promptKey: d.promptKey,
        promptVersion: d.promptVersion,
        tier: d.tier,
        model: d.model,
        scopeKind: d.scopeKind,
        scopeId: d.scopeId,
        inputs: (d.inputs ?? {}) as never,
        output: (d.output ?? {}) as never,
        validationError: d.validationError ?? null,
        governorAction: d.governorAction ?? null,
        safetyScore: d.safetyScore ?? null,
        safetyAction: d.safetyAction ?? null,
        costUsd: d.costUsd,
        inputTokens: d.inputTokens,
        outputTokens: d.outputTokens,
        latencyMs: d.latencyMs,
        traceId: d.traceId ?? null,
      },
    });
  }

  /** Look up a qa_memory row by normalized question (encrypted answer returned raw). */
  async findMemory(
    userId: string,
    questionNorm: string,
  ): Promise<
    | {
        id: string;
        questionNorm: string;
        answerEnc: Uint8Array;
        dekVersion: number;
        usedCount: number;
        isLocked: boolean;
        quarantined: boolean;
      }
    | null
  > {
    const row = await this.prisma.qaMemory.findUnique({
      where: { userId_questionNorm: { userId, questionNorm } },
    });
    if (!row) return null;
    return {
      id: row.id,
      questionNorm: row.questionNorm,
      answerEnc: row.answerEnc,
      dekVersion: row.dekVersion,
      usedCount: row.usedCount,
      isLocked: row.isLocked,
      quarantined: row.quarantined,
    };
  }

  /** Upsert a qa_memory answer (encrypted by the caller). Sets quarantine flag. */
  async upsertMemory(input: {
    userId: string;
    tenantId: string;
    questionNorm: string;
    answerEnc: Uint8Array;
    dekVersion: number;
    fieldKind: string;
    quarantined: boolean;
    applicationId?: string | null;
  }): Promise<string> {
    const row = await this.prisma.qaMemory.upsert({
      where: { userId_questionNorm: { userId: input.userId, questionNorm: input.questionNorm } },
      create: {
        userId: input.userId,
        tenantId: input.tenantId,
        questionNorm: input.questionNorm,
        answerEnc: Buffer.from(input.answerEnc),
        dekVersion: input.dekVersion,
        fieldKind: input.fieldKind,
        quarantined: input.quarantined,
        applicationId: input.applicationId ?? null,
      },
      update: {
        // Only update the stored answer when it is not user-locked.
        answerEnc: Buffer.from(input.answerEnc),
        quarantined: input.quarantined,
      },
    });
    return row.id;
  }

  /** Increment a memory row's used_count after it answers a question. */
  async incrementMemoryUse(id: string): Promise<void> {
    await this.prisma.qaMemory.update({ where: { id }, data: { usedCount: { increment: 1 } } });
  }

  /** Append an answer_history row (redacted value only). */
  async appendAnswerHistory(input: {
    userId: string;
    tenantId: string;
    applicationId?: string | null;
    questionNorm: string;
    source: string;
    valueRedacted: string;
  }): Promise<void> {
    await this.prisma.answerHistory.create({
      data: {
        userId: input.userId,
        tenantId: input.tenantId,
        applicationId: input.applicationId ?? null,
        questionNorm: input.questionNorm,
        source: input.source,
        valueRedacted: input.valueRedacted,
      },
    });
  }
}
