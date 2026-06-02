// Bridge between automation-core's layered selectors and a DriverPage. Resolves
// a LayeredSelector against the live page, returning the matched concrete
// selector string (so the caller can then click/type on it). Drift is logged by
// the caller via isDriftSignal.

import { resolveLayered, type LayeredSelector, type SelectorStrategy } from '@apex/automation-core';
import type { DriverPage } from '../browser/driver.js';

/** Turn a strategy into a concrete page selector string the driver understands. */
export function strategyToSelector(s: SelectorStrategy): string {
  switch (s.kind) {
    case 'testid':
      return `[data-test-id="${s.value}"]`;
    case 'role':
      // value already looks like `button[aria-label^="..."]` etc.
      return s.value;
    case 'text':
      return `text=${s.value}`;
    case 'css':
    case 'nth':
      return s.value;
  }
}

export interface ResolvedSelector {
  /** Concrete selector string for the matched strategy, or null if exhausted. */
  selector: string | null;
  /** The matched strategy kind (for drift telemetry). */
  matchedKind: SelectorStrategy['kind'] | null;
  attempts: number;
}

/** Resolve a layered selector against the page; returns the concrete selector. */
export async function resolveOnPage(page: DriverPage, layered: LayeredSelector): Promise<ResolvedSelector> {
  const outcome = await resolveLayered(layered, (strategy) => page.exists(strategyToSelector(strategy)));
  return {
    selector: outcome.matched ? strategyToSelector(outcome.matched) : null,
    matchedKind: outcome.matched?.kind ?? null,
    attempts: outcome.attempts,
  };
}
