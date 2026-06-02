// PrismaDecisionSink — bridges the gateway's DecisionSink port to @apex/db's
// AiRepository. This is the DB integration for the AI engine: atomic cost debit
// (audit B1), ledger-state reads for the governor, and ai_decisions persistence.
//
// Reference: docs/architecture/07-ai-engine.md §7, §8.

import type { AiDecisionRecord, GovernorState } from '@apex/ai-core';
import type { AiRepository } from '@apex/db';
import type { DecisionSink } from './gateway.js';

export interface PrismaDecisionSinkOptions {
  repo: AiRepository;
  tenantId: string;
  /** Default daily ceiling (USD) applied to new ledger rows. */
  defaultCeilingUsd: number;
  clock?: () => Date;
}

export class PrismaDecisionSink implements DecisionSink {
  private readonly clock: () => Date;

  constructor(private readonly opts: PrismaDecisionSinkOptions) {
    this.clock = opts.clock ?? ((): Date => new Date());
  }

  tryDebit(userId: string, costUsd: number): Promise<boolean> {
    return this.opts.repo.tryDebit(userId, this.opts.tenantId, costUsd, this.opts.defaultCeilingUsd, this.clock());
  }

  ledgerState(userId: string): Promise<GovernorState> {
    return this.opts.repo.ledgerState(userId, this.opts.defaultCeilingUsd, this.clock());
  }

  async record(decision: AiDecisionRecord): Promise<void> {
    await this.opts.repo.recordDecision({
      tenantId: this.opts.tenantId,
      userId: decision.userId,
      promptKey: decision.promptKey,
      promptVersion: decision.promptVersion,
      tier: decision.tier,
      model: decision.model,
      scopeKind: decision.scopeKind,
      scopeId: decision.scopeId,
      inputs: decision.inputs,
      output: decision.output,
      validationError: decision.validationError ?? null,
      governorAction: decision.governorAction,
      costUsd: decision.costUsd,
      inputTokens: decision.inputTokens,
      outputTokens: decision.outputTokens,
      latencyMs: decision.latencyMs,
      traceId: decision.traceId ?? null,
    });
  }
}
