// Layered selectors. Each logical element declares an ordered list of selector
// strategies; the first that resolves wins. This is what makes adapters robust
// to selector drift (§14). The resolution policy is pure and testable; the
// actual DOM query is injected by the worker.
//
// Reference: docs/architecture/06-automation-engine.md §14.

import { ValidationError } from '@apex/shared-errors';

/** Strategy kinds in preferred order: stable test ids first, brittle fallbacks last. */
export type SelectorStrategyKind = 'testid' | 'role' | 'text' | 'css' | 'nth';

export interface SelectorStrategy {
  kind: SelectorStrategyKind;
  value: string;
}

/** A named element with an ordered fallback chain. */
export interface LayeredSelector {
  /** Logical element name, e.g. "easyApplyButton". */
  name: string;
  strategies: SelectorStrategy[];
}

/** Canonical preference order; lower index = more stable/preferred. */
const STRATEGY_PREFERENCE: SelectorStrategyKind[] = ['testid', 'role', 'text', 'css', 'nth'];

export function strategyPreferenceRank(kind: SelectorStrategyKind): number {
  return STRATEGY_PREFERENCE.indexOf(kind);
}

/**
 * Build a LayeredSelector, sorting strategies by preference so the most stable
 * is tried first regardless of declaration order. Throws if no strategies given.
 */
export function layered(name: string, strategies: SelectorStrategy[]): LayeredSelector {
  if (strategies.length === 0) {
    throw new ValidationError(`LayeredSelector "${name}" must declare at least one strategy`, [
      { path: ['strategies'], message: 'at least one strategy required', code: 'empty' },
    ]);
  }
  const sorted = strategies
    .slice()
    .sort((a, b) => strategyPreferenceRank(a.kind) - strategyPreferenceRank(b.kind));
  return { name, strategies: sorted };
}

/** Resolves a single strategy against the DOM; returns true if it matched. */
export type StrategyResolver = (strategy: SelectorStrategy) => Promise<boolean>;

export interface ResolveOutcome {
  resolved: boolean;
  /** The strategy that matched, or null when the whole chain was exhausted. */
  matched: SelectorStrategy | null;
  /** How many strategies were attempted. */
  attempts: number;
}

/**
 * Try each strategy in order until one resolves. Returns which matched (for
 * drift telemetry: if only the last fallback matches, the adapter is drifting).
 * The resolver is injected, so this is fully unit-testable without a browser.
 */
export async function resolveLayered(
  selector: LayeredSelector,
  resolver: StrategyResolver,
): Promise<ResolveOutcome> {
  let attempts = 0;
  for (const strategy of selector.strategies) {
    attempts++;
    if (await resolver(strategy)) {
      return { resolved: true, matched: strategy, attempts };
    }
  }
  return { resolved: false, matched: null, attempts };
}

/**
 * True when the matched strategy is a brittle fallback (not the preferred one),
 * signalling possible drift the canary should flag.
 */
export function isDriftSignal(selector: LayeredSelector, outcome: ResolveOutcome): boolean {
  if (!outcome.resolved || outcome.matched === null) return false;
  const preferred = selector.strategies[0];
  return preferred !== undefined && outcome.matched.kind !== preferred.kind;
}
