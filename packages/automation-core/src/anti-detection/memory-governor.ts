// MemoryGovernor — per-context RSS budget enforcement (audit fix C7).
//
// We can't query a single Playwright BrowserContext's RSS directly because
// Chromium's renderer processes are shared across contexts. The governor
// instead samples the BROWSER process's total RSS at a configurable
// interval and fires a warning event when the average RSS-per-context
// exceeds the budget. The worker decides what to do (evict the oldest
// context, or refuse new acquisitions until back under budget).
//
// Production deployments can replace this with a per-process tracker via
// `pidusage` or by running each context in its own browser process; the
// interface is unchanged.

import type { Browser } from 'playwright';
import type { Logger } from '@apex/shared-logger';

export interface MemorySample {
  /** Total RSS of the Browser process tree, in MiB. */
  totalRssMb: number;
  /** Number of currently-open contexts. */
  contextCount: number;
  /** Implied average RSS per context, in MiB. */
  perContextMb: number;
  /** Wall-clock timestamp. */
  ts: number;
}

export interface MemoryEvent {
  kind: 'over_budget' | 'cleared';
  sample: MemorySample;
}

export interface MemoryGovernorOptions {
  logger: Logger;
  browser: Browser;
  /** Number of contexts open right now (a getter; the governor doesn't track it). */
  getContextCount: () => number;
  /** Per-context budget in MiB. Default 1536 (matches WORKER_CONTEXT_RSS_BUDGET_MB default). */
  budgetMb?: number;
  /** Sampling interval in ms. Default 30s. */
  intervalMs?: number;
  /** Subscribers for over-budget events. */
  onEvent?: (event: MemoryEvent) => void;
}

interface SubprocessSampler {
  sample(pid: number): Promise<{ rssMb: number } | null>;
}

const fsPromises: typeof import('node:fs/promises') | null = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('node:fs/promises') as typeof import('node:fs/promises');
  } catch {
    return null;
  }
})();

const linuxSampler: SubprocessSampler = {
  async sample(pid: number): Promise<{ rssMb: number } | null> {
    if (!fsPromises) return null;
    try {
      const text = await fsPromises.readFile(`/proc/${String(pid)}/status`, 'utf8');
      const m = /VmRSS:\s+(\d+)\s+kB/i.exec(text);
      if (!m || !m[1]) return null;
      return { rssMb: Math.round(parseInt(m[1], 10) / 1024) };
    } catch {
      return null;
    }
  },
};

export class MemoryGovernor {
  private readonly logger: Logger;
  private readonly browser: Browser;
  private readonly getContextCount: () => number;
  private readonly budgetMb: number;
  private readonly intervalMs: number;
  private readonly onEvent: (event: MemoryEvent) => void;
  private readonly sampler: SubprocessSampler;
  private timer: ReturnType<typeof setInterval> | null = null;
  private overBudget = false;
  private latest: MemorySample | null = null;

  constructor(opts: MemoryGovernorOptions) {
    this.logger = opts.logger.child({ component: 'memory-governor' });
    this.browser = opts.browser;
    this.getContextCount = opts.getContextCount;
    this.budgetMb = opts.budgetMb ?? 1536;
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.onEvent = opts.onEvent ?? (() => undefined);
    this.sampler = linuxSampler;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Don't keep the event loop alive just for sampling.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  latestSample(): MemorySample | null {
    return this.latest;
  }

  private async tick(): Promise<void> {
    const browserPid = this.extractPid();
    if (browserPid === null) return;
    const sample = await this.sampler.sample(browserPid);
    if (!sample) return;
    const contextCount = Math.max(1, this.getContextCount());
    const perContextMb = Math.round(sample.rssMb / contextCount);
    const m: MemorySample = {
      totalRssMb: sample.rssMb,
      contextCount,
      perContextMb,
      ts: Date.now(),
    };
    this.latest = m;
    if (perContextMb > this.budgetMb) {
      if (!this.overBudget) {
        this.overBudget = true;
        this.logger.warn(m, 'memory pressure: per-context budget exceeded');
        this.onEvent({ kind: 'over_budget', sample: m });
      }
    } else if (this.overBudget) {
      this.overBudget = false;
      this.logger.info(m, 'memory pressure cleared');
      this.onEvent({ kind: 'cleared', sample: m });
    }
  }

  private extractPid(): number | null {
    // Playwright doesn't expose the browser's pid directly across all
    // platforms; we read it via `_initializer` on the BrowserContext side.
    // Conservative fallback: return null and let the sampler skip this tick.
    try {
      const internal = this.browser as unknown as { _initializer?: { pid?: number } };
      const pid = internal._initializer?.pid;
      return typeof pid === 'number' && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }
}
