// PlaywrightBrowserDriver — the real driver, backed by playwright-core. This is
// executable production code; it is exercised only when a Chromium binary is
// present (integration / production). Unit tests use FakeBrowserDriver instead.
//
// Reference: docs/architecture/06-automation-engine.md §5, §6 (anti-detection),
//            §13 (browser isolation / egress allowlist).

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
} from 'playwright-core';
import type {
  BrowserDriver,
  ContextOptions,
  DriverBrowser,
  DriverContext,
  DriverPage,
  StorageState,
} from './driver.js';

const DEFAULT_NAV_TIMEOUT_MS = 30_000;

/** Hostname of a URL, or '' when unparseable. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** True when `host` is the allowlisted host or a subdomain of it. */
function hostAllowed(host: string, allow: string[]): boolean {
  return allow.some((a) => host === a || host.endsWith(`.${a}`));
}

class PwPage implements DriverPage {
  constructor(private readonly page: Page) {}

  async goto(url: string, opts?: { waitUntilMs?: number }): Promise<{ status: number; url: string }> {
    const resp = await this.page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: opts?.waitUntilMs ?? DEFAULT_NAV_TIMEOUT_MS,
    });
    return { status: resp?.status() ?? 0, url: this.page.url() };
  }

  url(): string {
    return this.page.url();
  }

  title(): Promise<string> {
    return this.page.title();
  }

  async visibleText(): Promise<string> {
    return (await this.page.locator('body').innerText().catch(() => '')) || '';
  }

  iframeSrcs(): Promise<string[]> {
    return this.page.$$eval('iframe', (frames) =>
      frames.map((f) => f.src).filter((s): s is string => Boolean(s)),
    );
  }

  async exists(selector: string): Promise<boolean> {
    return (await this.page.locator(selector).count()) > 0;
  }

  async textOf(selector: string): Promise<string | null> {
    const loc = this.page.locator(selector).first();
    if ((await loc.count()) === 0) return null;
    return (await loc.innerText().catch(() => null))?.trim() ?? null;
  }

  attrOf(selector: string, attr: string): Promise<string | null> {
    return this.page.locator(selector).first().getAttribute(attr);
  }

  async click(selector: string): Promise<void> {
    await this.page.locator(selector).first().click({ timeout: DEFAULT_NAV_TIMEOUT_MS });
  }

  async type(selector: string, text: string, opts?: { delayMs?: number }): Promise<void> {
    await this.page.locator(selector).first().pressSequentially(text, { delay: opts?.delayMs ?? 0 });
  }

  async setInputFiles(
    selector: string,
    file: { name: string; mimeType: string; buffer: Uint8Array },
  ): Promise<void> {
    await this.page.locator(selector).first().setInputFiles({
      name: file.name,
      mimeType: file.mimeType,
      buffer: Buffer.from(file.buffer),
    });
  }

  async screenshot(opts?: { maskSelectors?: string[] }): Promise<Uint8Array> {
    const mask = (opts?.maskSelectors ?? []).map((s) => this.page.locator(s));
    const buf = await this.page.screenshot({ fullPage: false, mask });
    return new Uint8Array(buf);
  }

  async waitForIdle(timeoutMs: number): Promise<void> {
    await this.page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {
      // networkidle can legitimately never settle on busy SPAs; bounded wait only.
    });
  }
}

class PwContext implements DriverContext {
  constructor(private readonly ctx: BrowserContext) {}

  async newPage(): Promise<DriverPage> {
    const page = await this.ctx.newPage();
    return new PwPage(page);
  }

  async storageState(): Promise<StorageState> {
    const state = await this.ctx.storageState();
    return { cookies: state.cookies, origins: state.origins };
  }

  async close(): Promise<void> {
    await this.ctx.close();
  }
}

class PwBrowser implements DriverBrowser {
  constructor(private readonly browser: Browser) {}

  async newContext(opts: ContextOptions): Promise<DriverContext> {
    const ctx = await this.browser.newContext({
      userAgent: opts.device.userAgent,
      locale: opts.device.languages[0] ?? 'en-US',
      timezoneId: opts.device.timezone,
      viewport: { width: opts.device.screen.width, height: opts.device.screen.height },
      deviceScaleFactor: 1,
      ...(opts.storageState ? { storageState: opts.storageState as never } : {}),
    });

    // Egress allowlist (browser isolation §13): abort any request to a host that
    // is not explicitly allowed.
    await ctx.route('**/*', (route: Route) => {
      const host = hostOf(route.request().url());
      if (host === '' || hostAllowed(host, opts.allowedHosts)) {
        void route.continue();
      } else {
        void route.abort('blockedbyclient');
      }
    });

    return new PwContext(ctx);
  }

  isConnected(): boolean {
    return this.browser.isConnected();
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}

export interface PlaywrightDriverOptions {
  headless?: boolean;
  /** Extra launch args (e.g. for hardened sandboxes). */
  args?: string[];
  /** Explicit executable path when not using the bundled download. */
  executablePath?: string | undefined;
}

export class PlaywrightBrowserDriver implements BrowserDriver {
  readonly engine = 'chromium' as const;

  constructor(private readonly opts: PlaywrightDriverOptions = {}) {}

  async launch(): Promise<DriverBrowser> {
    const browser = await chromium.launch({
      headless: this.opts.headless ?? true,
      args: this.opts.args ?? ['--disable-blink-features=AutomationControlled'],
      ...(this.opts.executablePath ? { executablePath: this.opts.executablePath } : {}),
    });
    return new PwBrowser(browser);
  }
}
