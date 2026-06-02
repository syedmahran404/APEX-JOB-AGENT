// FakeBrowserDriver — an in-memory BrowserDriver for unit tests and offline
// development. It records navigations and lets tests script page responses, so
// the entire worker runtime (pool, tasks, recovery) can be exercised without a
// Chromium binary. NOT used in production (the worker wires PlaywrightBrowserDriver).

import type {
  BrowserDriver,
  ContextOptions,
  DriverBrowser,
  DriverContext,
  DriverPage,
  StorageState,
} from './driver.js';

/** Scripted responses a test can preload for the fake page. */
export interface FakePageScript {
  currentUrl?: string;
  title?: string;
  visibleText?: string;
  iframeSrcs?: string[];
  /** selector -> exists */
  exists?: Record<string, boolean>;
  /** selector -> text */
  text?: Record<string, string>;
  /** "selector|attr" -> value */
  attr?: Record<string, string>;
  /** goto(url) -> status */
  gotoStatus?: number;
}

export class FakePage implements DriverPage {
  public readonly clicks: string[] = [];
  public readonly typed: Array<{ selector: string; text: string }> = [];
  public readonly navigations: string[] = [];
  public readonly screenshots: Array<{ maskSelectors: string[] }> = [];
  private _url: string;

  constructor(private readonly script: FakePageScript = {}) {
    this._url = script.currentUrl ?? 'about:blank';
  }

  goto(url: string): Promise<{ status: number; url: string }> {
    this.navigations.push(url);
    this._url = url;
    return Promise.resolve({ status: this.script.gotoStatus ?? 200, url });
  }
  url(): string {
    return this._url;
  }
  title(): Promise<string> {
    return Promise.resolve(this.script.title ?? '');
  }
  visibleText(): Promise<string> {
    return Promise.resolve(this.script.visibleText ?? '');
  }
  iframeSrcs(): Promise<string[]> {
    return Promise.resolve(this.script.iframeSrcs ?? []);
  }
  exists(selector: string): Promise<boolean> {
    return Promise.resolve(this.script.exists?.[selector] ?? false);
  }
  textOf(selector: string): Promise<string | null> {
    return Promise.resolve(this.script.text?.[selector] ?? null);
  }
  attrOf(selector: string, attr: string): Promise<string | null> {
    return Promise.resolve(this.script.attr?.[`${selector}|${attr}`] ?? null);
  }
  click(selector: string): Promise<void> {
    this.clicks.push(selector);
    return Promise.resolve();
  }
  type(selector: string, text: string): Promise<void> {
    this.typed.push({ selector, text });
    return Promise.resolve();
  }
  setInputFiles(): Promise<void> {
    return Promise.resolve();
  }
  screenshot(opts?: { maskSelectors?: string[] }): Promise<Uint8Array> {
    this.screenshots.push({ maskSelectors: opts?.maskSelectors ?? [] });
    // 1x1 PNG-ish bytes; content irrelevant for tests.
    return Promise.resolve(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  }
  waitForIdle(): Promise<void> {
    return Promise.resolve();
  }
}

export class FakeContext implements DriverContext {
  public closed = false;
  public storageSaves = 0;
  constructor(
    public readonly opts: ContextOptions,
    private readonly pageScript: FakePageScript,
  ) {}

  newPage(): Promise<DriverPage> {
    return Promise.resolve(new FakePage(this.pageScript));
  }
  storageState(): Promise<StorageState> {
    this.storageSaves++;
    return Promise.resolve({ cookies: [{ name: 'li_at', value: 'x' }], origins: [] });
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

export class FakeBrowser implements DriverBrowser {
  public contexts: FakeContext[] = [];
  private connected = true;
  constructor(private readonly pageScript: FakePageScript) {}

  newContext(opts: ContextOptions): Promise<DriverContext> {
    const ctx = new FakeContext(opts, this.pageScript);
    this.contexts.push(ctx);
    return Promise.resolve(ctx);
  }
  isConnected(): boolean {
    return this.connected;
  }
  /** Simulate a browser crash for crash-recovery tests. */
  simulateCrash(): void {
    this.connected = false;
  }
  close(): Promise<void> {
    this.connected = false;
    return Promise.resolve();
  }
}

export class FakeBrowserDriver implements BrowserDriver {
  readonly engine = 'fake' as const;
  public launches = 0;
  public lastBrowser: FakeBrowser | null = null;

  constructor(private readonly pageScript: FakePageScript = {}) {}

  launch(): Promise<DriverBrowser> {
    this.launches++;
    const b = new FakeBrowser(this.pageScript);
    this.lastBrowser = b;
    return Promise.resolve(b);
  }
}
