// AiGateway — the single entry point for every consequential AI call. It chains
// the ai-core primitives into one auditable pipeline:
//
//   1. cost governor decision (pass / downgrade / skip) using the ledger state
//   2. atomic ledger debit (audit B1) — abort if it would breach the ceiling
//   3. resolve the active prompt def (tier, schema, safety, fallback ladder)
//   4. ProviderRouter call (primary → backup failover on transport errors)
//   5. structured-output validation against the prompt's Zod schema
//   6. on validation failure: stricter retry, then walk the tier fallback ladder
//   7. build a PII-redacted ai_decisions record and hand it to the sink
//
// All side effects are behind ports (CostLedger, DecisionSink), so the gateway is
// fully unit-testable with the MockProvider + in-memory ports.
//
// Reference: docs/architecture/07-ai-engine.md §5, §7, §8.

import {
  buildDecisionRecord,
  decide as governorDecide,
  estimateCost,
  planNextAttempt,
  resolveModel,
  stricterRetryMessage,
  adjustTemperature,
  validateOutput,
  type AiDecisionRecord,
  type ChatMessage,
  type GovernorAction,
  type GovernorState,
  type ModelRegistry,
  type PromptDef,
  type PromptKey,
  type PromptRegistry,
  type Tier,
} from '@apex/ai-core';
import { PreconditionFailedError } from '@apex/shared-errors';
import type { ProviderRouter } from '../providers/router.js';

/** Persists ai_decisions rows + performs the atomic cost debit (audit B1). */
export interface DecisionSink {
  /** Atomic debit; returns false when the call would breach the daily ceiling. */
  tryDebit(userId: string, costUsd: number): Promise<boolean>;
  /** Current ledger state for the governor decision. */
  ledgerState(userId: string): Promise<GovernorState>;
  /** Persist the audited decision. */
  record(decision: AiDecisionRecord): Promise<void>;
}

export interface RunPromptInput<TInputs> {
  promptKey: PromptKey;
  userId: string;
  scopeKind: AiDecisionRecord['scopeKind'];
  scopeId: string;
  /** Raw structured inputs (redacted before audit). */
  inputs: TInputs;
  /** The user message(s) to send (already assembled by the caller). */
  messages: ChatMessage[];
  /** Whether this prompt is non-essential (governed harder under budget pressure). */
  nonEssential?: boolean;
  traceId?: string | undefined;
}

export type RunPromptResult<T> =
  | { ok: true; value: T; decision: AiDecisionRecord }
  | { ok: false; reason: 'budget-skip' | 'validation-failed'; detail: string; decision: AiDecisionRecord };

export interface AiGatewayDeps {
  registry: ModelRegistry;
  prompts: PromptRegistry;
  router: ProviderRouter;
  sink: DecisionSink;
  clock?: () => Date;
}

export class AiGateway {
  private readonly clock: () => Date;

  constructor(private readonly deps: AiGatewayDeps) {
    this.clock = deps.clock ?? ((): Date => new Date());
  }

  /** Compose the system prompt: base instruction + encoded safety rules. */
  private systemPrompt(def: PromptDef): string {
    const safety = def.safety.length > 0 ? `\n\nSafety rules:\n- ${def.safety.join('\n- ')}` : '';
    return `You are the APEX ${def.key} engine.${safety}`;
  }

  /**
   * Run a prompt end to end. Generic over the validated output type; the caller
   * passes the prompt key whose schema produces `T`.
   */
  async run<T>(input: RunPromptInput<unknown>): Promise<RunPromptResult<T>> {
    const started = Date.now();
    const def = this.deps.prompts.active(input.promptKey);
    const nonEssential = input.nonEssential ?? false;

    // Governor decision from current ledger state + estimated worst-case cost.
    const state = await this.deps.sink.ledgerState(input.userId);
    const primaryModel = resolveModel(this.deps.registry, def.tier);
    const estCost = estimateCost(primaryModel, { inputTokens: def.maxTokens, outputTokens: def.maxTokens });
    const decision = governorDecide(state, { tier: def.tier, estimatedCostUsd: estCost, nonEssential });

    return this.execute<T>(input, def, decision, started);
  }

  // ---- internal execution (kept separate for clarity/testing) ----

  private async execute<T>(
    input: RunPromptInput<unknown>,
    def: PromptDef,
    decision: ReturnType<typeof governorDecide>,
    startedMs: number,
  ): Promise<RunPromptResult<T>> {
    const now = this.clock();

    if (decision.action === 'skip') {
      const record = buildDecisionRecord({
        promptKey: def.key,
        promptVersion: def.version,
        tier: def.tier,
        model: resolveModel(this.deps.registry, def.tier).model,
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
        userId: input.userId,
        rawInputs: input.inputs,
        output: null,
        governorAction: 'skip',
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Date.now() - startedMs,
        traceId: input.traceId,
        now,
      });
      await this.deps.sink.record(record);
      return { ok: false, reason: 'budget-skip', detail: decision.reason, decision: record };
    }

    let tier: Tier = decision.effectiveTier;
    let temperature = def.temperature;
    let attempt = 0;
    let lastIssues = '';
    let totalCost = 0;
    let inTok = 0;
    let outTok = 0;
    let lastModel = resolveModel(this.deps.registry, tier).model;
    let governorAction: GovernorAction = decision.action;
    const messages: ChatMessage[] = [...input.messages];

    // Up to: initial + stricter retry + ladder steps.
    const maxAttempts = 2 + def.fallback.length;
    while (attempt < maxAttempts) {
      const routed = await this.deps.router.complete(tier, {
        system: this.systemPrompt(def),
        messages,
        temperature,
        maxTokens: def.maxTokens,
        ...(def.topP !== undefined ? { topP: def.topP } : {}),
        responseFormat: def.responseFormat === 'json' ? 'json' : 'text',
      });
      lastModel = routed.model.model;
      inTok += routed.result.usage.inputTokens;
      outTok += routed.result.usage.outputTokens;
      totalCost += estimateCost(routed.model, routed.result.usage);

      const parsed = validateOutput(def.outputSchema, routed.result.output);
      if (parsed.ok) {
        // Atomic debit AFTER a successful, validated call (we pay for usable work).
        const debited = await this.deps.sink.tryDebit(input.userId, totalCost);
        const record = buildDecisionRecord({
          promptKey: def.key,
          promptVersion: def.version,
          tier,
          model: lastModel,
          scopeKind: input.scopeKind,
          scopeId: input.scopeId,
          userId: input.userId,
          rawInputs: input.inputs,
          output: parsed.value,
          governorAction,
          costUsd: totalCost,
          inputTokens: inTok,
          outputTokens: outTok,
          latencyMs: Date.now() - startedMs,
          traceId: input.traceId,
          now,
        });
        await this.deps.sink.record(record);
        if (!debited) {
          // Extremely rare: concurrent calls raced past the ceiling. Honor the
          // ledger and surface a precondition failure (no silent overspend).
          throw new PreconditionFailedError('AI daily cost ceiling reached', { userId: input.userId });
        }
        return { ok: true, value: parsed.value as T, decision: record };
      }

      lastIssues = parsed.issues;
      const plan = planNextAttempt(def, attempt);
      if (plan.action === 'give-up') break;
      if (plan.action === 'retry-stricter') {
        temperature = adjustTemperature(temperature, plan.temperatureDelta);
        messages.push({ role: 'user', content: stricterRetryMessage(parsed.issues) });
      } else {
        // fallback: escalate the tier.
        tier = plan.tier;
        governorAction = 'pass';
        messages.push({ role: 'user', content: stricterRetryMessage(parsed.issues) });
      }
      attempt++;
    }

    // Exhausted: record the failure (raw output + issues) and report.
    await this.deps.sink.tryDebit(input.userId, totalCost);
    const record = buildDecisionRecord({
      promptKey: def.key,
      promptVersion: def.version,
      tier,
      model: lastModel,
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      userId: input.userId,
      rawInputs: input.inputs,
      output: null,
      validationError: lastIssues,
      governorAction,
      costUsd: totalCost,
      inputTokens: inTok,
      outputTokens: outTok,
      latencyMs: Date.now() - startedMs,
      traceId: input.traceId,
      now,
    });
    await this.deps.sink.record(record);
    return { ok: false, reason: 'validation-failed', detail: lastIssues, decision: record };
  }
}
