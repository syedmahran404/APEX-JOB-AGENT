import { describe, it, expect } from 'vitest';
import { redactInputs, buildDecisionRecord, PII_DENY_KEYS } from './decision.js';

describe('audit/decision redactInputs', () => {
  it('redacts known PII keys recursively, keeps structural fields', () => {
    const input = {
      questionNorm: 'notice period',
      candidateIds: ['m1', 'm2'],
      profile: { email: 'a@b.com', phone: '+91999', noticePeriodDays: 30, fullName: 'Alice' },
      answer: 'should be stripped (lives in output)',
    };
    const red = redactInputs(input) as Record<string, unknown>;
    expect(red.questionNorm).toBe('notice period');
    expect(red.candidateIds).toEqual(['m1', 'm2']);
    const profile = red.profile as Record<string, unknown>;
    expect(profile.email).toBe('[REDACTED]');
    expect(profile.phone).toBe('[REDACTED]');
    expect(profile.fullName).toBe('[REDACTED]');
    expect(profile.noticePeriodDays).toBe(30); // structural, kept
    expect(red.answer).toBe('[REDACTED]');
  });

  it('handles arrays and primitives', () => {
    expect(redactInputs([{ email: 'x' }, 1, 'a'])).toEqual([{ email: '[REDACTED]' }, 1, 'a']);
    expect(redactInputs(null)).toBeNull();
  });

  it('deny-list covers the documented PII keys', () => {
    for (const k of ['email', 'phone', 'ssn', 'password', 'token', 'answer']) {
      expect(PII_DENY_KEYS.has(k)).toBe(true);
    }
  });
});

describe('audit/decision buildDecisionRecord', () => {
  it('builds a redacted, complete decision row', () => {
    const rec = buildDecisionRecord({
      promptKey: 'app.answer',
      promptVersion: 1,
      tier: 'default',
      model: 'claude-sonnet-4',
      scopeKind: 'application',
      scopeId: 'app-1',
      userId: 'u-1',
      rawInputs: { questionNorm: 'notice period', email: 'a@b.com' },
      output: { answer: 30, confidence: 0.9 },
      governorAction: 'pass',
      costUsd: 0.002,
      inputTokens: 100,
      outputTokens: 20,
      latencyMs: 850,
      now: new Date('2026-06-02T12:00:00.000Z'),
    });
    expect(rec.occurredAt).toBe('2026-06-02T12:00:00.000Z');
    expect((rec.inputs as Record<string, unknown>).email).toBe('[REDACTED]');
    expect((rec.inputs as Record<string, unknown>).questionNorm).toBe('notice period');
    expect(rec.governorAction).toBe('pass');
    expect(rec.costUsd).toBe(0.002);
  });
});
