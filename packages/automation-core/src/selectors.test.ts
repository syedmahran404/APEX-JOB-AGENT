import { describe, it, expect } from 'vitest';
import {
  layered,
  resolveLayered,
  isDriftSignal,
  strategyPreferenceRank,
  type SelectorStrategy,
} from './selectors.js';

describe('selectors (layered, drift-resistant)', () => {
  it('sorts strategies by preference: testid > role > text > css > nth', () => {
    const sel = layered('btn', [
      { kind: 'nth', value: ':nth-child(3)' },
      { kind: 'testid', value: 'apply' },
      { kind: 'css', value: '.apply' },
    ]);
    expect(sel.strategies.map((s) => s.kind)).toEqual(['testid', 'css', 'nth']);
  });

  it('throws when no strategies are provided', () => {
    expect(() => layered('x', [])).toThrowError(/at least one strategy/);
  });

  it('strategyPreferenceRank orders kinds', () => {
    expect(strategyPreferenceRank('testid')).toBeLessThan(strategyPreferenceRank('css'));
  });

  it('resolveLayered returns the first matching strategy', async () => {
    const sel = layered('btn', [
      { kind: 'testid', value: 'apply' },
      { kind: 'css', value: '.apply' },
    ]);
    // Only the css fallback matches.
    const resolver = (s: SelectorStrategy): Promise<boolean> => Promise.resolve(s.kind === 'css');
    const outcome = await resolveLayered(sel, resolver);
    expect(outcome.resolved).toBe(true);
    expect(outcome.matched?.kind).toBe('css');
    expect(outcome.attempts).toBe(2);
  });

  it('resolveLayered reports exhaustion when nothing matches', async () => {
    const sel = layered('btn', [{ kind: 'testid', value: 'apply' }]);
    const outcome = await resolveLayered(sel, () => Promise.resolve(false));
    expect(outcome.resolved).toBe(false);
    expect(outcome.matched).toBeNull();
  });

  it('isDriftSignal fires when a non-preferred fallback matches', async () => {
    const sel = layered('btn', [
      { kind: 'testid', value: 'apply' },
      { kind: 'css', value: '.apply' },
    ]);
    const onlyCss = (s: SelectorStrategy): Promise<boolean> => Promise.resolve(s.kind === 'css');
    const driftOutcome = await resolveLayered(sel, onlyCss);
    expect(isDriftSignal(sel, driftOutcome)).toBe(true);

    const preferred = (s: SelectorStrategy): Promise<boolean> => Promise.resolve(s.kind === 'testid');
    const cleanOutcome = await resolveLayered(sel, preferred);
    expect(isDriftSignal(sel, cleanOutcome)).toBe(false);
  });
});
