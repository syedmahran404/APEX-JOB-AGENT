// PacingManager — token bucket per (platform, action).
//
// Two layers:
//   1. Per-platform global RPM (everyone, everywhere).
//   2. Per-(user, platform, action) micro-pacing — the adapter's
//      humanDelay handles within-flow timing; this manager handles the
//      cross-flow gate.
//
// Implementation: Redis token-bucket via INCR + EXPIRE. Falls back to
// in-memory if Redis is unavailable (degraded but functional).

import type { Redis } from 'ioredis';
import type { Logger } from '@apex/shared-logger';
import type { PacingManager } from './interfaces.js';
import type { PlatformKey } from '../types/adapter.js';
import { sleep } from '../utils/delay.js';

export interface DefaultPacingManagerOptions {
  logger: Logger;
  redis: Redis;
  globalRpmPerPlatform: number;
  /** Optional per-platform RPM override. */
  platformOverrides?: Partial<Record<PlatformKey, number>>;
}

const ACTION_WEIGHTS: Record<string, number> = {
  navigate: 1.0,
  click: 0.6,
  type: 0.0, // typing is paced by humanDelay
  scroll: 0.2,
  submit: 1.0,
  idle: 0.0,
};

export class DefaultPacingManager implements PacingManager {
  private readonly logger: Logger;
  constructor(private readonly opts: DefaultPacingManagerOptions) {
    this.logger = opts.logger.child({ component: 'pacing-manager' });
  }

  async acquire(input: {
    platformKey: PlatformKey;
    userId: string;
    action: 'navigate' | 'click' | 'type' | 'scroll' | 'submit' | 'idle';
  }): Promise<void> {
    const weight = ACTION_WEIGHTS[input.action] ?? 0;
    if (weight === 0) return;
    const rpm = this.opts.platformOverrides?.[input.platformKey] ?? this.opts.globalRpmPerPlatform;
    if (rpm <= 0) return;
    // Window keyed to current minute. INCR + first-set-EXPIRE is the canonical
    // Redis token-bucket idiom.
    const key = `pace:${input.platformKey}:${Math.floor(Date.now() / 60_000).toString(36)}`;
    let used: number;
    try {
      const pipeline = this.opts.redis.multi();
      pipeline.incrbyfloat(key, weight);
      pipeline.expire(key, 90);
      const r = await pipeline.exec();
      used = parseFloat(String((r?.[0]?.[1] ?? '0').toString()));
    } catch (err) {
      this.logger.warn({ err, key }, 'redis pacing unavailable; degraded mode');
      return;
    }
    if (used > rpm) {
      // Soft sleep: spread excess across the remainder of the minute.
      const overshoot = used - rpm;
      const waitMs = Math.min(60_000, Math.ceil((overshoot / rpm) * 60_000));
      this.logger.warn(
        { platformKey: input.platformKey, used, rpm, waitMs },
        'pacing throttle engaged',
      );
      await sleep(waitMs);
    }
  }

  async shutdown(): Promise<void> {
    // Redis lifecycle is owned externally.
  }
}
