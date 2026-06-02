import { describe, it, expect } from 'vitest';
import { MockProvider, fakeEmbed } from './mock.js';

describe('providers/MockProvider', () => {
  it('returns a matched rule output and records the call', async () => {
    const p = new MockProvider({
      completions: [{ when: (r) => r.system.includes('score'), output: '{"results":[]}' }],
    });
    const res = await p.complete({
      model: 'm',
      system: 'you score jobs',
      messages: [{ role: 'user', content: 'go' }],
      temperature: 0.2,
      maxTokens: 100,
    });
    expect(res.output).toBe('{"results":[]}');
    expect(p.calls).toHaveLength(1);
  });

  it('falls back to {} when no rule matches', async () => {
    const p = new MockProvider();
    const res = await p.complete({ model: 'm', system: 's', messages: [], temperature: 0, maxTokens: 10 });
    expect(res.output).toBe('{}');
  });

  it('produces deterministic, L2-normalized embeddings of the configured dim', async () => {
    const p = new MockProvider({ embedDim: 1024 });
    const r1 = await p.embed({ model: 'e', inputs: ['hello world'] });
    const r2 = await p.embed({ model: 'e', inputs: ['hello world'] });
    expect(r1.dim).toBe(1024);
    expect(r1.vectors[0]).toEqual(r2.vectors[0]); // deterministic
    const norm = Math.sqrt((r1.vectors[0] ?? []).reduce((s, x) => s + x * x, 0));
    expect(norm).toBeGreaterThan(0.99);
    expect(norm).toBeLessThan(1.01);
  });

  it('fakeEmbed of different text differs', () => {
    expect(fakeEmbed('a', 64)).not.toEqual(fakeEmbed('b', 64));
  });
});
