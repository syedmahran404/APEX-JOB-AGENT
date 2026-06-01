// Layered selector resolution.
//
// Adapter `selectors.ts` files declare each element as an ordered array of
// candidates: prefer data-test-id, then accessible name, then text, then
// nth-child fallback. The engine walks the array in order and returns the
// first locator that resolves to ≥ 1 element. If none resolves we throw
// SelectorDriftError so the worker can capture the page and emit a drift
// incident.

import type { Page, Locator, BrowserContext } from 'playwright';
import { SelectorDriftError } from '../types/errors.js';

/** A single layer of a layered selector definition. */
export interface SelectorLayer {
  /** Required: a Playwright selector string. */
  readonly selector: string;
  /** Optional human label for diagnostics. */
  readonly label?: string;
  /** Optional waitFor visibility before considering this layer resolved. */
  readonly visible?: boolean;
  /** Optional max time to wait for this layer (ms). Default 250ms (cheap). */
  readonly timeoutMs?: number;
}

/** A layered selector — first layer to resolve wins. */
export interface LayeredSelector {
  /** Logical name (e.g. "easy-apply-button"). Used in error messages + drift telemetry. */
  readonly name: string;
  readonly layers: ReadonlyArray<SelectorLayer>;
}

export interface ResolveOptions {
  /** Total budget across all layers; takes precedence over per-layer timeouts. */
  totalTimeoutMs?: number;
  /** Adapter context for diagnostics (passed to SelectorDriftError). */
  platformKey: string;
  adapterVersion: string;
}

/**
 * Resolve a layered selector against a page. Returns the first matching
 * Locator (by definition order). Throws SelectorDriftError if none match.
 */
export async function resolveLayered(
  page: Page,
  selector: LayeredSelector,
  opts: ResolveOptions,
): Promise<Locator> {
  const tStart = Date.now();
  const totalBudget = opts.totalTimeoutMs ?? 5_000;
  let lastErr: unknown = null;

  for (const layer of selector.layers) {
    if (Date.now() - tStart > totalBudget) break;
    const layerTimeout = layer.timeoutMs ?? Math.min(750, totalBudget);
    const locator = page.locator(layer.selector);
    try {
      if (layer.visible === true) {
        await locator.first().waitFor({ state: 'visible', timeout: layerTimeout });
      } else {
        await locator.first().waitFor({ state: 'attached', timeout: layerTimeout });
      }
      return locator.first();
    } catch (err) {
      lastErr = err;
      // try next layer
    }
  }

  throw new SelectorDriftError({
    selector: selector.name,
    platformKey: opts.platformKey,
    adapterVersion: opts.adapterVersion,
    cause: lastErr,
  });
}

/**
 * Best-effort: returns the locator if any layer matches in `peekTimeoutMs`,
 * else null. Used by `canApply()` and similar inspection helpers where the
 * absence of an element is itself a signal (no exception).
 */
export async function peekLayered(
  page: Page,
  selector: LayeredSelector,
  peekTimeoutMs = 500,
): Promise<Locator | null> {
  for (const layer of selector.layers) {
    const locator = page.locator(layer.selector);
    try {
      await locator.first().waitFor({ state: 'attached', timeout: peekTimeoutMs });
      return locator.first();
    } catch {
      // try next layer
    }
  }
  return null;
}

/** All currently visible elements matching any layer. Used by list iteration (search). */
export async function resolveAllLayered(
  page: Page,
  selector: LayeredSelector,
  opts: ResolveOptions,
): Promise<Locator> {
  // Tries each layer; returns the first that yields ≥ 1 element.
  for (const layer of selector.layers) {
    const locator = page.locator(layer.selector);
    try {
      const count = await locator.count();
      if (count > 0) return locator;
    } catch {
      // try next layer
    }
  }
  throw new SelectorDriftError({
    selector: `${selector.name}[]`,
    platformKey: opts.platformKey,
    adapterVersion: opts.adapterVersion,
  });
}

/**
 * For pages that load in iframes (some platforms wrap their auth widget).
 * Walks all frames in `context` and returns the first that has the layer.
 * Falls back to top-frame Page if no frame matches.
 */
export async function findFrameWithSelector(
  context: BrowserContext,
  selector: LayeredSelector,
  peekTimeoutMs = 500,
): Promise<{ frame: import('playwright').Frame | null; locator: Locator | null }> {
  for (const page of context.pages()) {
    for (const frame of page.frames()) {
      for (const layer of selector.layers) {
        const locator = frame.locator(layer.selector);
        try {
          await locator.first().waitFor({ state: 'attached', timeout: peekTimeoutMs });
          return { frame, locator: locator.first() };
        } catch {
          // continue
        }
      }
    }
  }
  return { frame: null, locator: null };
}
