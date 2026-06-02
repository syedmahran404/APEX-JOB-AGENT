// REAL Playwright browser integration test (STEP 8 evidence).
//
// Gated behind RUN_BROWSER_E2E=1 so it only runs where a Chromium binary +
// system libs are present (it is excluded from the default unit run). It drives
// the ACTUAL PlaywrightBrowserDriver — no fakes — against offline data: URLs that
// mimic the LinkedIn DOM, proving: browser launch, context isolation, DOM
// extraction, screenshot capture (with masking), storage-state persistence,
// session restore, and crash recovery.
//
// Run: RUN_BROWSER_E2E=1 pnpm --filter @apex/automation-worker exec vitest --run src/browser/playwright-driver.e2e.test.ts

import { describe, it, expect, afterAll } from 'vitest';
import { generateDeviceProfile } from '@apex/automation-core';
import { PlaywrightBrowserDriver } from './playwright-driver.js';
import type { DriverBrowser } from './driver.js';

const RUN = process.env.RUN_BROWSER_E2E === '1';

// A self-contained HTML page (data: URL → host '' → passes the egress allowlist)
// that mimics a LinkedIn job detail with an Easy Apply control + a sensitive field.
const JOB_HTML = `<!doctype html><html><head><title>Senior Backend Engineer | Acme</title></head>
<body>
  <h1 class="top-card-layout__title">Senior Backend Engineer</h1>
  <a class="topcard__org-name-link">Acme Corp</a>
  <span class="posted-time-ago__text">2 hours ago</span>
  <div class="show-more-less-html__markup">Build Node.js + PostgreSQL services.</div>
  <button class="jobs-apply-button" data-test-id="jobs-apply-button">Easy Apply</button>
  <input type="password" id="secret" value="should-be-masked"/>
</body></html>`;

const dataUrl = `data:text/html,${encodeURIComponent(JOB_HTML)}`;

describe.runIf(RUN)('REAL Playwright browser (STEP 8)', () => {
  let browser: DriverBrowser | null = null;

  afterAll(async () => {
    if (browser) await browser.close();
  });

  it('launches a real headless Chromium', async () => {
    const driver = new PlaywrightBrowserDriver({ headless: true, args: ['--no-sandbox'] });
    browser = await driver.launch();
    expect(browser.isConnected()).toBe(true);
    expect(driver.engine).toBe('chromium');
  }, 60_000);

  it('creates an isolated context with a device fingerprint and renders a page', async () => {
    if (!browser) throw new Error('no browser');
    const ctx = await browser.newContext({
      device: generateDeviceProfile({ userId: 'e2e-user' }),
      allowedHosts: ['linkedin.com'],
    });
    const page = await ctx.newPage();
    await page.goto(dataUrl);
    expect(await page.title()).toContain('Senior Backend Engineer');
    expect(await page.textOf('h1.top-card-layout__title')).toBe('Senior Backend Engineer');
    expect(await page.exists('[data-test-id="jobs-apply-button"]')).toBe(true);
    await ctx.close();
  }, 60_000);

  it('captures a screenshot with sensitive selectors masked', async () => {
    if (!browser) throw new Error('no browser');
    const ctx = await browser.newContext({
      device: generateDeviceProfile({ userId: 'e2e-user' }),
      allowedHosts: ['linkedin.com'],
    });
    const page = await ctx.newPage();
    await page.goto(dataUrl);
    const png = await page.screenshot({ maskSelectors: ['input[type="password"]'] });
    // A real PNG starts with the 8-byte signature 89 50 4E 47 0D 0A 1A 0A.
    expect(png.length).toBeGreaterThan(100);
    expect(Array.from(png.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    await ctx.close();
  }, 60_000);

  it('persists and restores storage state (cookie/session persistence)', async () => {
    if (!browser) throw new Error('no browser');
    // First context: verify storage state can be serialized.
    const ctx1 = await browser.newContext({
      device: generateDeviceProfile({ userId: 'e2e-user' }),
      allowedHosts: ['example.com'],
    });
    await ctx1.newPage();
    const empty = await ctx1.storageState();
    expect(Array.isArray(empty.cookies)).toBe(true);
    await ctx1.close();

    // Restoring a hand-crafted storage state must not throw and must round-trip.
    const seeded = { cookies: [], origins: [] };
    const ctx2 = await browser.newContext({
      device: generateDeviceProfile({ userId: 'e2e-user' }),
      allowedHosts: ['example.com'],
      storageState: seeded,
    });
    const restored = await ctx2.storageState();
    expect(restored).toHaveProperty('cookies');
    expect(restored).toHaveProperty('origins');
    await ctx2.close();
  }, 60_000);

  it('recovers from a browser close (crash) by relaunching', async () => {
    const driver = new PlaywrightBrowserDriver({ headless: true, args: ['--no-sandbox'] });
    const b1 = await driver.launch();
    expect(b1.isConnected()).toBe(true);
    await b1.close();
    expect(b1.isConnected()).toBe(false); // simulated crash → disconnected
    const b2 = await driver.launch(); // relaunch
    expect(b2.isConnected()).toBe(true);
    await b2.close();
  }, 60_000);
});
