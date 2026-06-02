import { describe, it, expect } from 'vitest';
import {
  MOCK_REGISTRY,
  MockProvider,
  PromptRegistry,
  defaultPromptRegistry,
  type AiDecisionRecord,
  type GovernorState,
} from '@apex/ai-core';
import { ProviderRouter, type ProviderMap } from '../providers/router.js';
import { AiGateway, type DecisionSink } from './gateway.js';

/** In-memory sink capturing debits + decisions; ledger state is injectable. */
class FakeSink implements DecisionSink {
  decisions: AiDecisionRecord[] = [];
  debits: number[] = [];
  constructor(private state: GovernorState = { spentTodayUsd: 0, dailyCeilingUsd: 100 }) {}
  setState(s: GovernorState): void {
    this.state = s;
  }
  tryDebit(_userId: string, costUsd: number): Promise<boolean> {
    this.debits.push(costUsd);
    return Promise.resolve(this.state.spentTodayUsd + costUsd <= this.state.dailyCeilingUsd);
  }
  ledgerState(): Promise<GovernorState> {
    return Promise.resolve(this.state);
  }
  record(decision: AiDecisionRecord): Promise<void> {
    this.decisions.push(decision);
    return Promise.resolve();
  }
}

function makeGateway(mock: MockProvider, sink: FakeSink): AiGateway {
  const providers: ProviderMap = { mock };
  const router = new ProviderRouter(MOCK_REGISTRY, providers);
  return new AiGateway({ registry: MOCK_REGISTRY, prompts: defaultPromptRegistry, router, sink, clock: () => new Date('2026-06-02T12:00:00Z') });
}

const validAnswer = '{"answer":30,"confidence":0.9,"rationale":"30-day notice period"}';

describe('AiGateway — end-to-end AI decision flow', () => {
  it('runs a prompt, validates output, debits, and records an audited decision', async () => {
    const mock = new MockProvider({ completions: [{ output: validAnswer }] });
    const sink = new FakeSink();
    const gateway = makeGateway(mock, sink);

    const res = await gateway.run({
      promptKey: 'app.answer',
      userId: '00000000-0000-4000-8000-000000000001',
      scopeKind: 'application',
      scopeId: '00000000-0000-4000-8000-000000000002',
      inputs: { fieldKind: 'number', email: 'leak@x.com' },
      messages: [{ role: 'user', content: 'notice period?' }],
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect((res.value as { answer: number }).answer).toBe(30);
    // exactly one decision recorded + one debit performed.
    expect(sink.decisions).toHaveLength(1);
    expect(sink.debits).toHaveLength(1);
    // audit redaction: PII key stripped from inputs.
    const rec = sink.decisions[0]!;
    expect((rec.inputs as Record<string, unknown>).email).toBe('[REDACTED]');
    expect(rec.governorAction).toBe('pass');
    expect(rec.costUsd).toBeGreaterThan(0);
  });

  it('skips when the budget is exhausted (>=95%) and records a skip decision', async () => {
    const mock = new MockProvider({ completions: [{ output: validAnswer }] });
    const sink = new FakeSink({ spentTodayUsd: 99, dailyCeilingUsd: 100 });
    const gateway = makeGateway(mock, sink);
    const res = await gateway.run({
      promptKey: 'app.answer',
      userId: '00000000-0000-4000-8000-000000000001',
      scopeKind: 'application',
      scopeId: '00000000-0000-4000-8000-000000000002',
      inputs: {},
      messages: [{ role: 'user', content: 'q' }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('budget-skip');
    // No provider call happened; a skip decision was still audited.
    expect(mock.calls).toHaveLength(0);
    expect(sink.decisions[0]?.governorAction).toBe('skip');
  });

  it('recovers via the stricter retry when the first output is invalid JSON', async () => {
    let call = 0;
    const mock = new MockProvider({
      completions: [
        {
          when: () => {
            call++;
            return call === 1;
          },
          output: 'sorry, the notice period is about thirty days', // invalid → fails schema
        },
        { output: validAnswer }, // second call (stricter retry) → valid
      ],
    });
    const sink = new FakeSink();
    const gateway = makeGateway(mock, sink);
    const res = await gateway.run({
      promptKey: 'app.answer',
      userId: '00000000-0000-4000-8000-000000000001',
      scopeKind: 'application',
      scopeId: '00000000-0000-4000-8000-000000000002',
      inputs: {},
      messages: [{ role: 'user', content: 'q' }],
    });
    expect(res.ok).toBe(true);
    expect(mock.calls.length).toBeGreaterThanOrEqual(2); // retried
  });

  it('reports validation-failed after exhausting retry + fallback ladder', async () => {
    const mock = new MockProvider({ completions: [{ output: 'never valid json' }] });
    const sink = new FakeSink();
    const gateway = makeGateway(mock, sink);
    const res = await gateway.run({
      promptKey: 'app.answer', // ladder = [{tier:'reason'}]
      userId: '00000000-0000-4000-8000-000000000001',
      scopeKind: 'application',
      scopeId: '00000000-0000-4000-8000-000000000002',
      inputs: {},
      messages: [{ role: 'user', content: 'q' }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('validation-failed');
    expect(sink.decisions[0]?.validationError).toBeTruthy();
  });

  it('throws when no active prompt version exists', async () => {
    const mock = new MockProvider();
    const sink = new FakeSink();
    const emptyPrompts = new PromptRegistry([]);
    const router = new ProviderRouter(MOCK_REGISTRY, { mock });
    const gateway = new AiGateway({ registry: MOCK_REGISTRY, prompts: emptyPrompts, router, sink });
    await expect(
      gateway.run({
        promptKey: 'app.answer',
        userId: '00000000-0000-4000-8000-000000000001',
        scopeKind: 'application',
        scopeId: '00000000-0000-4000-8000-000000000002',
        inputs: {},
        messages: [],
      }),
    ).rejects.toThrow(/No active prompt/);
  });
});
