// Behavior simulator — mouse paths, scroll easing, focus management.
//
// The BasePlatformAdapter already provides typeLikeHuman / pasteWithTail /
// humanDelay for keyboard + simple delays. This module adds the more
// elaborate behaviors adapters need for "feel": cursor curves and scroll
// patterns that are realistic without being theatrical.

import type { Locator, Page } from 'playwright';
import { sampleGaussian, sleep } from '../utils/delay.js';

/**
 * Move the mouse from its current position to the target along a Bezier
 * curve, sampling intermediate points. Uses Playwright's mouse.move(steps).
 *
 * The target is the locator's bounding box centroid + a small jitter so we
 * never click the exact center every time.
 */
export async function moveMouseTo(
  page: Page,
  locator: Locator,
  random: () => number,
): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new TypeError('locator has no bounding box');
  const jitterX = sampleGaussian(random, 0, box.width / 8, -box.width / 3, box.width / 3);
  const jitterY = sampleGaussian(random, 0, box.height / 8, -box.height / 3, box.height / 3);
  const targetX = box.x + box.width / 2 + jitterX;
  const targetY = box.y + box.height / 2 + jitterY;

  // Number of intermediate steps proportional to distance.
  const distancePx = 600; // playwright doesn't expose current cursor; use a fixed step count
  const steps = Math.max(8, Math.min(40, Math.ceil(distancePx / 24)));
  await page.mouse.move(targetX, targetY, { steps });
  return { x: targetX, y: targetY };
}

/** Click a locator with a curved approach + a brief dwell before mouse-down. */
export async function humanClick(
  page: Page,
  locator: Locator,
  random: () => number,
): Promise<void> {
  await moveMouseTo(page, locator, random);
  const dwell = sampleGaussian(random, 90, 40, 30, 240);
  await sleep(dwell);
  await locator.click({ delay: 30 });
}

/**
 * Smoothly scroll to bring `locator` into view; then a small additional
 * scroll past it (so the user "had to read it"). For list iteration during
 * search, see scrollSearchPage.
 */
export async function scrollIntoViewLikeHuman(
  page: Page,
  locator: Locator,
  random: () => number,
): Promise<void> {
  await locator.scrollIntoViewIfNeeded({ timeout: 5_000 });
  // Small overshoot then back.
  const overshoot = Math.floor(sampleGaussian(random, 60, 30, -20, 180));
  await page.mouse.wheel(0, overshoot);
  await sleep(sampleGaussian(random, 200, 80, 80, 600));
  if (overshoot > 0) {
    await page.mouse.wheel(0, -Math.floor(overshoot * 0.6));
  }
}

/**
 * Search-page scroll loop: scrolls in `chunks` by viewport-height fractions,
 * with realistic pauses every 1–3 chunks. Stops when `predicate` returns
 * true (e.g., "did we get to the bottom?") or after `maxChunks`.
 */
export async function scrollSearchPage(
  page: Page,
  random: () => number,
  predicate: () => Promise<boolean>,
  maxChunks = 30,
): Promise<void> {
  const viewport = page.viewportSize();
  const chunkPx = viewport ? Math.floor(viewport.height * 0.6) : 480;
  for (let i = 0; i < maxChunks; i++) {
    if (await predicate()) return;
    await page.mouse.wheel(0, chunkPx + Math.floor(sampleGaussian(random, 0, 40, -120, 120)));
    // Pause every 1–3 chunks for ~200–600ms (humans pause to read).
    if (random() < 0.4) {
      await sleep(sampleGaussian(random, 380, 160, 160, 900));
    } else {
      await sleep(sampleGaussian(random, 120, 60, 40, 320));
    }
  }
}

/**
 * Clear a field and focus it before typing. Use before typeLikeHuman when
 * the field may already contain a value (e.g., autofilled fields).
 */
export async function focusAndClear(locator: Locator): Promise<void> {
  await locator.click({ delay: 30 });
  await locator.press('Control+A').catch(() => undefined);
  await locator.press('Meta+A').catch(() => undefined);
  await locator.press('Backspace').catch(() => undefined);
}
