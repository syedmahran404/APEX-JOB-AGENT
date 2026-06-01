// Cancellable delay primitives. The engine and adapters use these instead
// of bare setTimeout so cancellation propagates without dangling timers.

import { CancellationError } from '../types/errors.js';

/** Sleep for `ms` milliseconds, throwing CancellationError if signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted) throw new CancellationError(signal.reason as string | undefined);
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = (): void => {
      if (timer !== null) clearTimeout(timer);
      reject(new CancellationError(typeof signal?.reason === 'string' ? signal.reason : 'cancelled'));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
  });
}

/** Random integer in [min, max] (inclusive) using the supplied PRNG. */
export function randInt(random: () => number, min: number, max: number): number {
  if (max < min) throw new RangeError('max < min');
  return Math.floor(random() * (max - min + 1)) + min;
}

/** Sample from a Gaussian distribution via Box-Muller, clamped to [min, max]. */
export function sampleGaussian(
  random: () => number,
  mean: number,
  stdev: number,
  min: number,
  max: number,
): number {
  // Box-Muller: two uniforms → one normal.
  let u = 0;
  let v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  const value = mean + stdev * z;
  return Math.min(max, Math.max(min, value));
}

/** Throw CancellationError if the signal has aborted. Cheap; safe in tight loops. */
export function checkCancellation(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new CancellationError(typeof signal.reason === 'string' ? signal.reason : 'cancelled');
  }
}
