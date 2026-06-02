import { describe, it, expect } from 'vitest';
import {
  extractJson,
  validateOutput,
  stricterRetryMessage,
  planNextAttempt,
  adjustTemperature,
} from './validation.js';
import { AppAnswerOutput, JobScoreOutput } from './prompts/schemas.js';
import { defaultPromptRegistry } from './prompts/registry.js';

describe('validation/extractJson', () => {
  it('strips ```json fences', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('extracts a bare object from surrounding prose', () => {
    expect(extractJson('Here you go: {"a":1} thanks')).toBe('{"a":1}');
  });
  it('extracts an array', () => {
    expect(extractJson('result [1,2,3] end')).toBe('[1,2,3]');
  });
});

describe('validation/validateOutput', () => {
  it('parses a valid app.answer', () => {
    const out = validateOutput(AppAnswerOutput, '{"answer":30,"confidence":0.9,"rationale":"notice period"}');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.answer).toBe(30);
  });
  it('fails on a non-JSON output with readable issue', () => {
    const out = validateOutput(AppAnswerOutput, 'about eighty');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.issues).toMatch(/not valid JSON/i);
  });
  it('fails on a schema violation (score out of range)', () => {
    const out = validateOutput(JobScoreOutput, '{"results":[{"jobId":"j","score":150,"drivers":{"matchedSkills":[],"salaryFit":"unknown","locationFit":"good","titleAlignment":0.5},"reasoning":"x","risks":[]}]}');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.issues).toMatch(/score/);
  });
});

describe('validation/fallback ladder', () => {
  it('first failure → stricter retry at same tier, cooler', () => {
    const prompt = defaultPromptRegistry.active('app.answer');
    const plan = planNextAttempt(prompt, 0);
    expect(plan.action).toBe('retry-stricter');
    if (plan.action === 'retry-stricter') {
      expect(plan.tier).toBe('default');
      expect(plan.temperatureDelta).toBeLessThan(0);
    }
  });
  it('second failure → walk fallback ladder (app.answer → reason)', () => {
    const prompt = defaultPromptRegistry.active('app.answer');
    const plan = planNextAttempt(prompt, 1);
    expect(plan.action).toBe('fallback');
    if (plan.action === 'fallback') expect(plan.tier).toBe('reason');
  });
  it('exhausted ladder → give up (resume.tailor has no fallback)', () => {
    const prompt = defaultPromptRegistry.active('resume.tailor');
    expect(planNextAttempt(prompt, 1).action).toBe('give-up');
  });
  it('stricterRetryMessage embeds issues', () => {
    expect(stricterRetryMessage('answer: required')).toMatch(/failed to parse: answer: required/);
  });
  it('adjustTemperature clamps to [0,1]', () => {
    expect(adjustTemperature(0.2, -0.1)).toBe(0.1);
    expect(adjustTemperature(0.05, -0.2)).toBe(0);
    expect(adjustTemperature(0.95, 0.2)).toBe(1);
  });
});
