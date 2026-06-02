// BrowserDriver port — the thin abstraction the pool, adapters, and tasks use to
// touch a browser. Two implementations exist:
//   - PlaywrightBrowserDriver (real, drives playwright-core),
//   - FakeBrowserDriver (in-memory, for unit tests; in test files only).
//
// Keeping every browser interaction behind this port means the worker runtime
// (pool lifecycle, session restore, screenshot capture, task orchestration) is
// fully unit-testable without a browser binary, while the production path uses
// real Playwright.
//
// Reference: docs/architecture/06-automation-engine.md §5, §13.

import type { DeviceProfile } from '@apex/automation-core';

/** Storage state = cookies + localStorage, as Playwright serializes it. */
export interface StorageState {
  cookies: unknown[];
  origins: unknown[];
}

/** Options for creating an isolated browsing context for a (user, platform). */
export interface ContextOptions {
  /** Device fingerprint to present (UA, viewport, locale, timezone). */
  device: DeviceProfile;
  /** Restored storage state, when resuming a session. */
  storageState?: StorageState | undefined;
  /** Egress allowlist — only these hosts may be reached (browser isolation). */
  allowedHosts: string[];
}

/** A page handle scoped to a context. Minimal surface the adapters need. */
export interface DriverPage {
  goto(url: string, opts?: { waitUntilMs?: number }): Promise<{ status: number; url: string }>;
  /** Current URL. */
  url(): string;
  /** Page title. */
  title(): Promise<string>;
  /** Visible text content of the document body (for challenge detection). */
  visibleText(): Promise<string>;
  /** `src` attributes of all iframes (for CAPTCHA detection). */
  iframeSrcs(): Promise<string[]>;
  /** Returns true if a CSS/role/text selector currently resolves. */
  exists(selector: string): Promise<boolean>;
  /** Read trimmed text for a selector, or null when absent. */
  textOf(selector: string): Promise<string | null>;
  /** Read an attribute for a selector, or null. */
  attrOf(selector: string, attr: string): Promise<string | null>;
  /** Click a selector (after human-like pacing applied by the caller). */
  click(selector: string): Promise<void>;
  /** Type into a selector. */
  type(selector: string, text: string, opts?: { delayMs?: number }): Promise<void>;
  /** Set an input file (resume upload). */
  setInputFiles(selector: string, file: { name: string; mimeType: string; buffer: Uint8Array }): Promise<void>;
  /** Capture a PNG screenshot; sensitive selectors are masked. */
  screenshot(opts?: { maskSelectors?: string[] }): Promise<Uint8Array>;
  /** Wait for the network to be idle (bounded). */
  waitForIdle(timeoutMs: number): Promise<void>;
}

/** An isolated browsing context (one warm context per (user, platform)). */
export interface DriverContext {
  newPage(): Promise<DriverPage>;
  /** Serialize cookies + localStorage for persistence. */
  storageState(): Promise<StorageState>;
  close(): Promise<void>;
}

/** A launched browser process (shared across contexts of the same family). */
export interface DriverBrowser {
  newContext(opts: ContextOptions): Promise<DriverContext>;
  /** True while the underlying process is alive (crash detection). */
  isConnected(): boolean;
  close(): Promise<void>;
}

/** The driver: launches browsers. */
export interface BrowserDriver {
  launch(): Promise<DriverBrowser>;
  /** Engine name, for diagnostics. */
  readonly engine: 'chromium' | 'fake';
}
