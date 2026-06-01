// BrowserManager — owns the Browser pool and (user, platform)-keyed
// BrowserContext lifecycle.
//
// Pool model:
//   - One Browser per family (chromium default). Lazily launched.
//   - One BrowserContext per (userId, platformKey). Reused across calls
//     within `contextTtlMs`. After the TTL, the context is saved-and-closed.
//   - Concurrency cap: contexts beyond `maxConcurrentContexts` block on a
//     small in-process semaphore. When at cap, oldest idle context is evicted.
//
// Storage state restoration is the SessionManager's responsibility; this
// manager only requests the path via `acquire(opts.storageStatePath)`.

import { chromium, firefox, webkit, type Browser, type BrowserContext, type LaunchOptions } from 'playwright';
import type { Logger } from '@apex/shared-logger';
import type { BrowserAcquisition, BrowserFingerprintProfile, BrowserManager } from './interfaces.js';
import type { PlatformKey } from '../types/adapter.js';
import { newUlid } from '../utils/ulid.js';

interface PooledContext {
  context: BrowserContext;
  contextKey: string;
  userId: string;
  platformKey: PlatformKey;
  acquiredAt: number;
  lastUsedAt: number;
  inUse: boolean;
}

export interface DefaultBrowserManagerOptions {
  logger: Logger;
  family?: 'chromium' | 'firefox' | 'webkit';
  headless?: boolean;
  maxConcurrentContexts?: number;
  contextTtlMs?: number;
  /** Optional Playwright launch overrides. */
  launchOptions?: LaunchOptions;
}

export class DefaultBrowserManager implements BrowserManager {
  private readonly logger: Logger;
  private readonly family: 'chromium' | 'firefox' | 'webkit';
  private readonly headless: boolean;
  private readonly maxConcurrent: number;
  private readonly contextTtlMs: number;
  private readonly launchOptions: LaunchOptions;
  private browser: Browser | null = null;
  private launchPromise: Promise<Browser> | null = null;
  private pool = new Map<string, PooledContext>();
  private shuttingDown = false;

  constructor(opts: DefaultBrowserManagerOptions) {
    this.logger = opts.logger.child({ component: 'browser-manager' });
    this.family = opts.family ?? 'chromium';
    this.headless = opts.headless ?? true;
    this.maxConcurrent = opts.maxConcurrentContexts ?? 4;
    this.contextTtlMs = opts.contextTtlMs ?? 10 * 60_000;
    this.launchOptions = opts.launchOptions ?? {};
  }

  async getBrowser(): Promise<Browser> {
    if (this.browser !== null && this.browser.isConnected()) return this.browser;
    if (this.launchPromise !== null) return this.launchPromise;
    this.launchPromise = this.launchBrowser();
    try {
      this.browser = await this.launchPromise;
      return this.browser;
    } finally {
      this.launchPromise = null;
    }
  }

  private async launchBrowser(): Promise<Browser> {
    const driver = this.family === 'firefox' ? firefox : this.family === 'webkit' ? webkit : chromium;
    this.logger.info({ family: this.family, headless: this.headless }, 'launching browser');
    const browser = await driver.launch({
      headless: this.headless,
      // Conservative defaults — anti-detection layers add per-context tweaks.
      args:
        this.family === 'chromium'
          ? [
              '--disable-blink-features=AutomationControlled',
              '--no-sandbox',
              '--disable-dev-shm-usage',
            ]
          : undefined,
      ...this.launchOptions,
    });
    browser.on('disconnected', () => {
      this.logger.warn('browser disconnected');
      this.browser = null;
    });
    return browser;
  }

  async acquire(opts: {
    userId: string;
    platformKey: PlatformKey;
    storageStatePath?: string;
    fingerprintProfile?: BrowserFingerprintProfile;
  }): Promise<BrowserAcquisition> {
    if (this.shuttingDown) {
      throw new TypeError('BrowserManager is shutting down; cannot acquire');
    }
    const key = `${opts.userId}:${opts.platformKey}`;
    const existing = this.pool.get(key);
    if (existing && !existing.inUse && Date.now() - existing.lastUsedAt < this.contextTtlMs) {
      existing.inUse = true;
      existing.lastUsedAt = Date.now();
      this.logger.debug({ key }, 'reusing warm browser context');
      return this.makeAcquisition(existing, false);
    }

    if (existing && existing.inUse) {
      throw new TypeError(
        `BrowserManager: context ${key} is already in use (per-(user,platform) semaphore violated)`,
      );
    }

    // Evict oldest idle if at cap.
    while (this.pool.size >= this.maxConcurrent) {
      const oldestIdle = this.findOldestIdle();
      if (!oldestIdle) {
        // All in use — wait briefly and retry. The engine guarantees
        // sequential per-(user,platform) so this should be rare.
        await new Promise((r) => setTimeout(r, 250));
        if (this.pool.size < this.maxConcurrent) break;
        const evicted = this.findOldestIdle();
        if (!evicted) {
          throw new TypeError('BrowserManager pool exhausted with all contexts in use');
        }
        await this.evict(evicted);
      } else {
        await this.evict(oldestIdle);
      }
    }

    const browser = await this.getBrowser();
    const fp = opts.fingerprintProfile;
    const context = await browser.newContext({
      ...(opts.storageStatePath ? { storageState: opts.storageStatePath } : {}),
      ...(fp
        ? {
            userAgent: fp.userAgent,
            viewport: fp.viewport,
            timezoneId: fp.timezoneId,
            locale: fp.locale,
            colorScheme: fp.colorScheme,
            deviceScaleFactor: 1,
          }
        : {}),
    });

    // Apply additional anti-detection page-init scripts.
    await context.addInitScript(() => {
      // Hide the webdriver flag.
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      // Common UA-CH client hints leak: ensure plugins.length > 0.
      Object.defineProperty(navigator, 'plugins', {
        get: () => [{ name: 'PDF Viewer' }, { name: 'Chrome PDF Viewer' }, { name: 'Native Client' }],
      });
    });

    const pooled: PooledContext = {
      context,
      contextKey: `${key}:${newUlid()}`,
      userId: opts.userId,
      platformKey: opts.platformKey,
      acquiredAt: Date.now(),
      lastUsedAt: Date.now(),
      inUse: true,
    };
    this.pool.set(key, pooled);
    this.logger.info(
      { key, restored: opts.storageStatePath !== undefined, contextKey: pooled.contextKey },
      'created browser context',
    );
    return this.makeAcquisition(pooled, opts.storageStatePath !== undefined);
  }

  activeCount(): number {
    return this.pool.size;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const pooled of this.pool.values()) {
      try {
        await pooled.context.close();
      } catch (err) {
        this.logger.warn({ err, contextKey: pooled.contextKey }, 'context close failed');
      }
    }
    this.pool.clear();
    if (this.browser !== null) {
      try {
        await this.browser.close();
      } catch (err) {
        this.logger.warn({ err }, 'browser close failed');
      }
      this.browser = null;
    }
  }

  private makeAcquisition(pooled: PooledContext, restored: boolean): BrowserAcquisition {
    let released = false;
    return {
      context: pooled.context,
      contextKey: pooled.contextKey,
      restored,
      release: async () => {
        if (released) return;
        released = true;
        pooled.inUse = false;
        pooled.lastUsedAt = Date.now();
      },
    };
  }

  private findOldestIdle(): PooledContext | null {
    let oldest: PooledContext | null = null;
    for (const p of this.pool.values()) {
      if (p.inUse) continue;
      if (!oldest || p.lastUsedAt < oldest.lastUsedAt) oldest = p;
    }
    return oldest;
  }

  private async evict(pooled: PooledContext): Promise<void> {
    this.logger.info(
      { contextKey: pooled.contextKey, ageMs: Date.now() - pooled.acquiredAt },
      'evicting browser context',
    );
    try {
      await pooled.context.close();
    } catch (err) {
      this.logger.warn({ err, contextKey: pooled.contextKey }, 'context close failed during evict');
    }
    const key = `${pooled.userId}:${pooled.platformKey}`;
    this.pool.delete(key);
  }
}
