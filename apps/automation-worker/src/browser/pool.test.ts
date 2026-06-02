import { describe, it, expect } from 'vitest';
import { generateDeviceProfile, CONTEXT_IDLE_TTL_MS, type PlatformKey } from '@apex/automation-core';
import { PooledBrowserManager, type StorageStateStore, type ContextProvisioner } from './pool.js';
import { FakeBrowserDriver } from './fake-driver.js';
import type { StorageState } from './driver.js';

function inMemoryStore(): StorageStateStore & { saved: Map<string, StorageState> } {
  const saved = new Map<string, StorageState>();
  return {
    saved,
    load(userId, platform): Promise<StorageState | null> {
      return Promise.resolve(saved.get(`${userId}:${platform}`) ?? null);
    },
    save(userId, platform, state): Promise<void> {
      saved.set(`${userId}:${platform}`, state);
      return Promise.resolve();
    },
  };
}

const provisioner: ContextProvisioner = {
  deviceFor: (userId) => Promise.resolve(generateDeviceProfile({ userId })),
  allowedHostsFor: () => ['linkedin.com'],
};

function makePool(now: () => number, driver = new FakeBrowserDriver()) {
  const store = inMemoryStore();
  const pool = new PooledBrowserManager({ driver, store, provisioner, now });
  return { pool, store, driver };
}

const USER = 'u-1';
const PLATFORM: PlatformKey = 'linkedin';

describe('browser/PooledBrowserManager (lifecycle)', () => {
  it('launches a browser lazily on first acquire and creates one context', async () => {
    const t = 1000;
    const { pool, driver } = makePool(() => t);
    const lease = await pool.acquire(USER, PLATFORM);
    expect(lease.userId).toBe(USER);
    expect(driver.launches).toBe(1);
    expect(driver.lastBrowser?.contexts).toHaveLength(1);
    await pool.shutdown();
  });

  it('reuses a warm context within the idle TTL (no second context)', async () => {
    let t = 1000;
    const { pool, driver } = makePool(() => t);
    await pool.acquire(USER, PLATFORM);
    pool.setSessionStatus(USER, PLATFORM, 'authenticated'); // task confirms login
    t += CONTEXT_IDLE_TTL_MS - 1;
    await pool.acquire(USER, PLATFORM);
    expect(driver.lastBrowser?.contexts).toHaveLength(1); // reused
    await pool.shutdown();
  });

  it('refreshes (new context) once idle past the TTL, persisting storage state', async () => {
    let t = 1000;
    const { pool, store, driver } = makePool(() => t);
    await pool.acquire(USER, PLATFORM);
    pool.setSessionStatus(USER, PLATFORM, 'authenticated'); // so TTL governs, not status
    t += CONTEXT_IDLE_TTL_MS + 1;
    await pool.acquire(USER, PLATFORM);
    expect(driver.lastBrowser?.contexts).toHaveLength(2); // recreated
    expect(store.saved.has(`${USER}:${PLATFORM}`)).toBe(true); // persisted before close
    await pool.shutdown();
  });

  it('keeps the same context for re-auth (expired session) — task re-logs-in in place', async () => {
    let t = 1000;
    const { pool, driver } = makePool(() => t);
    await pool.acquire(USER, PLATFORM);
    pool.setSessionStatus(USER, PLATFORM, 'expired');
    t += 1000; // within TTL
    await pool.acquire(USER, PLATFORM);
    expect(driver.lastBrowser?.contexts).toHaveLength(1); // NOT recreated
    await pool.shutdown();
  });

  it('release persists storage state for crash/restart restore', async () => {
    const t = 1000;
    const { pool, store } = makePool(() => t);
    const lease = await pool.acquire(USER, PLATFORM);
    await pool.release(lease);
    expect(store.saved.get(`${USER}:${PLATFORM}`)?.cookies).toHaveLength(1);
    await pool.shutdown();
  });

  it('restores persisted storage state into a new context (session reuse)', async () => {
    const t = 1000;
    const { pool, store, driver } = makePool(() => t);
    // Pre-seed a saved session.
    await store.save(USER, PLATFORM, { cookies: [{ name: 'li_at', value: 'restored' }], origins: [] });
    await pool.acquire(USER, PLATFORM);
    const ctx = driver.lastBrowser?.contexts[0];
    expect(ctx?.opts.storageState).toBeDefined();
    await pool.shutdown();
  });

  it('evicts idle contexts past TTL and persists their state', async () => {
    const t = 1000;
    const { pool, store } = makePool(() => t);
    await pool.acquire(USER, PLATFORM);
    const evicted = await pool.evictIdle(t + CONTEXT_IDLE_TTL_MS + 1);
    expect(evicted).toBe(1);
    expect(store.saved.has(`${USER}:${PLATFORM}`)).toBe(true);
    await pool.shutdown();
  });

  it('recovers from a browser crash by relaunching on next acquire', async () => {
    const t = 1000;
    const { pool, driver } = makePool(() => t);
    await pool.acquire(USER, PLATFORM);
    expect(driver.launches).toBe(1);
    // Simulate the browser process dying.
    driver.lastBrowser?.simulateCrash();
    await pool.acquire(USER, PLATFORM);
    expect(driver.launches).toBe(2); // relaunched
    await pool.shutdown();
  });

  it('applies the per-platform egress allowlist to new contexts', async () => {
    const t = 1000;
    const { pool, driver } = makePool(() => t);
    await pool.acquire(USER, PLATFORM);
    expect(driver.lastBrowser?.contexts[0]?.opts.allowedHosts).toContain('linkedin.com');
    await pool.shutdown();
  });
});
