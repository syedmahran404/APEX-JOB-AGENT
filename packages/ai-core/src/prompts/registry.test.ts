import { describe, it, expect } from 'vitest';
import { PromptRegistry, defaultPromptRegistry, type PromptKey } from './registry.js';

const ALL_KEYS: PromptKey[] = [
  'job.relevance.score',
  'app.answer',
  'resume.tailor',
  'cover.letter',
  'profile.review',
  'captcha.classify',
  'qa.normalize',
];

describe('prompts/registry', () => {
  it('registers all 7 prompts with an active version', () => {
    for (const key of ALL_KEYS) {
      const def = defaultPromptRegistry.active(key);
      expect(def.key).toBe(key);
      expect(def.isActive).toBe(true);
      expect(def.outputSchema).toBeDefined();
      expect(def.safety.length).toBeGreaterThan(0);
    }
  });

  it('assigns the spec tiers (resume.tailor + profile.review = reason; captcha/qa = fast)', () => {
    expect(defaultPromptRegistry.active('resume.tailor').tier).toBe('reason');
    expect(defaultPromptRegistry.active('profile.review').tier).toBe('reason');
    expect(defaultPromptRegistry.active('captcha.classify').tier).toBe('fast');
    expect(defaultPromptRegistry.active('qa.normalize').tier).toBe('fast');
    expect(defaultPromptRegistry.active('job.relevance.score').tier).toBe('default');
  });

  it('cover.letter + classification run JSON response format', () => {
    expect(defaultPromptRegistry.active('cover.letter').responseFormat).toBe('json');
    expect(defaultPromptRegistry.active('captcha.classify').responseFormat).toBe('json');
  });

  it('get(key, version) resolves explicit versions; unknown throws', () => {
    expect(defaultPromptRegistry.get('app.answer', 1).version).toBe(1);
    expect(() => defaultPromptRegistry.get('app.answer', 99)).toThrow(/not registered/);
  });

  it('active() throws when no active version exists', () => {
    const empty = new PromptRegistry([]);
    expect(() => empty.active('app.answer')).toThrow(/No active prompt/);
  });

  it('all() returns every registered def', () => {
    expect(defaultPromptRegistry.all().length).toBe(ALL_KEYS.length);
  });
});
