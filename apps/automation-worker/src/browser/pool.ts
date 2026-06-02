// PooledBrowserManager — concrete implementation of automation-core's BrowserPool
// interface, backed by a BrowserDriver port. Responsibilities:
//   - one warm DriverContext per (user, platform),
//   - TTL eviction (10 min idle) + 7-day max-age refresh (decideContext policy),
//   - storage-state persistence on release/evict (cookie + localStorage),
//   - browser crash detection + relaunch.
//
// Driver-agnostic → unit-testable with FakeBrowserDriver. Reference: §5, §18.

import {
  type BrowserPool,
  type LeasedContext,
  type PlatformKey,
  type DeviceProfile,
  pairKey,
  decideContext,
  type ContextMeta,
  CONTEXT_IDLE_TTL_MS,
} from '@apex/automation-core';
import type { BrowserDriver, DriverBrowser, DriverContext, StorageState } from './driver.js';

/** Persists/loads encrypted storage state. Implemented by the worker (S3 + crypto). */
export interface StorageStateStore {
  load(userId: string, platform: PlatformKey): Promise<StorageState | null>;
  save(userId: string, platform: PlatformKey, state: StorageState): Promise<void>;
}

/** Supplies the device fingerprint + egress allowlist for a (user, platform). */
export interface ContextProvisioner {
  deviceFor(userId: string, platform: PlatformKey): Promise<DeviceProfile>;
  allowedHostsFor(platform: PlatformKey): string[];
}

interface PoolEntry {
  context: DriverContext;
  meta: ContextMeta;
}

export interface PooledBrowserManagerOptions {
  driver: BrowserDriver;
  store: StorageStateStore;
  provisioner: ContextProvisioner;
  /** Injected clock for deterministic TTL tests. */
  now?: () => number;
}

export class PooledBrowserManager implements BrowserPool {
  private browser: DriverBrowser | null = null;
  private readonly entries = new Map<string, PoolEntry>();
  private readonly now: () => number;

  constructor(private readonly opts: PooledBrowserManagerOptions) {
    this.now = opts.now ?? ((): number => Date.now());
  }

  /** Ensure a live browser process, relaunching after a crash. */
  private async ensureBrowser(): Promise<DriverBrowser> {
    if (this.browser !== null && this.browser.isConnected()) return this.browser;
    // Crash recovery: a disconnected browser invalidates every warm context.
    if (this.browser !== null && !this.browser.isConnected()) {
      this.entries.clear();
    }
    this.browser = await this.opts.driver.launch();
    return this.browser;
  }

  async acquire(userId: string, platform: PlatformKey): Promise<LeasedContext> {
    const browser = await this.ensureBrowser();
    const key = pairKey(userId, platform);
    const now = this.now();
    const existing = this.entries.get(key);

    if (existing) {
      const decision = decideContext(existing.meta, now);
      // `refresh` (idle-TTL / 7-day max-age) is the only decision that destroys
      // and recreates the context. `reuse` keeps it as-is; `re-auth` ALSO keeps
      // the browsing context — the task layer re-logs-in inside it via the
      // adapter's ensureSession(). Recreating on every unverified session would
      // throw away warm contexts needlessly.
      if (decision.action !== 'refresh') {
        existing.meta.lastUsedAtMs = now;
        return { userId, platformKey: platform, browserContext: existing.context };
      }
      // refresh: persist what we have, close, and recreate.
      await this.persistAndClose(userId, platform, existing).catch(() => undefined);
      this.entries.delete(key);
    }

    const device = await this.opts.provisioner.deviceFor(userId, platform);
    const allowedHosts = this.opts.provisioner.allowedHostsFor(platform);
    const storageState = (await this.opts.store.load(userId, platform)) ?? undefined;
    const context = await browser.newContext({ device, allowedHosts, storageState });
    const entry: PoolEntry = {
      context,
      // A restored session is optimistically 'authenticated' (we hold cookies);
      // the task's ensureSession() confirms or downgrades it. A cold context
      // (no storage) is 'unknown' until the task logs in.
      meta: {
        createdAtMs: now,
        lastUsedAtMs: now,
        sessionStatus: storageState ? 'authenticated' : 'unknown',
      },
    };
    this.entries.set(key, entry);
    return { userId, platformKey: platform, browserContext: context };
  }

  /** Mark session status after a task observes it (drives re-auth decisions). */
  setSessionStatus(userId: string, platform: PlatformKey, status: ContextMeta['sessionStatus']): void {
    const entry = this.entries.get(pairKey(userId, platform));
    if (entry) entry.meta.sessionStatus = status;
  }

  async release(lease: LeasedContext): Promise<void> {
    const entry = this.entries.get(pairKey(lease.userId, lease.platformKey));
    if (!entry) return;
    entry.meta.lastUsedAtMs = this.now();
    // Persist storage state so a crash/restart can restore the session.
    const state = await entry.context.storageState();
    await this.opts.store.save(lease.userId, lease.platformKey, state);
  }

  async evictIdle(nowMs: number): Promise<number> {
    let evicted = 0;
    for (const [key, entry] of this.entries) {
      if (nowMs - entry.meta.lastUsedAtMs >= CONTEXT_IDLE_TTL_MS) {
        const [userId, platform] = splitKey(key);
        await this.persistAndClose(userId, platform, entry).catch(() => undefined);
        this.entries.delete(key);
        evicted++;
      }
    }
    return evicted;
  }

  stats(): { active: number; idle: number } {
    const now = this.now();
    let active = 0;
    let idle = 0;
    for (const entry of this.entries.values()) {
      if (now - entry.meta.lastUsedAtMs < CONTEXT_IDLE_TTL_MS) active++;
      else idle++;
    }
    return { active, idle };
  }

  async shutdown(): Promise<void> {
    for (const [key, entry] of this.entries) {
      const [userId, platform] = splitKey(key);
      await this.persistAndClose(userId, platform, entry).catch(() => undefined);
    }
    this.entries.clear();
    if (this.browser !== null) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
    }
  }

  private async persistAndClose(userId: string, platform: PlatformKey, entry: PoolEntry): Promise<void> {
    try {
      const state = await entry.context.storageState();
      await this.opts.store.save(userId, platform, state);
    } finally {
      await entry.context.close();
    }
  }
}

function splitKey(key: string): [string, PlatformKey] {
  const idx = key.lastIndexOf(':');
  return [key.slice(0, idx), key.slice(idx + 1) as PlatformKey];
}
