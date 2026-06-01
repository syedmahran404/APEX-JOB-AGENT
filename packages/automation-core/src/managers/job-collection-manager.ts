// JobCollectionManager — drains an adapter's discovery iterable into a
// bounded array. Honors cancellation and the adapter's `cap` so a runaway
// adapter cannot OOM the worker.

import type { Logger } from '@apex/shared-logger';
import { Domain } from '@apex/shared-types';
import type { JobCollectionManager } from './interfaces.js';
import type { AdapterContext, PlatformAdapter } from '../types/adapter.js';
import type { DiscoveredJob } from '../types/discovery.js';
import { CancellationError } from '../types/errors.js';
import { checkCancellation } from '../utils/delay.js';

export interface DefaultJobCollectionManagerOptions {
  logger: Logger;
}

export class DefaultJobCollectionManager implements JobCollectionManager {
  private readonly logger: Logger;
  constructor(opts: DefaultJobCollectionManagerOptions) {
    this.logger = opts.logger.child({ component: 'job-collection-manager' });
  }

  async collect(input: {
    adapter: PlatformAdapter;
    ctx: AdapterContext;
    filters: Domain.SearchFilters;
    cap: number;
  }): Promise<ReadonlyArray<DiscoveredJob>> {
    const { adapter, ctx, filters, cap } = input;
    const out: DiscoveredJob[] = [];
    const seen = new Set<string>();
    try {
      for await (const job of adapter.search(ctx, filters)) {
        checkCancellation(ctx.cancellation);
        if (out.length >= cap) break;
        // Defensive de-dupe within one pass on (platform_key, externalId).
        const dedupeKey = `${adapter.key}:${job.externalId}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        out.push(job);
      }
    } catch (err) {
      if (err instanceof CancellationError) throw err;
      this.logger.warn(
        { err, platformKey: adapter.key, collected: out.length },
        'discovery iterator threw — returning what we have',
      );
    }
    this.logger.info({ platformKey: adapter.key, collected: out.length, cap }, 'discovery complete');
    return out;
  }
}
