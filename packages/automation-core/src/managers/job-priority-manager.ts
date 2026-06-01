// JobPriorityManager — sorts kept candidates by freshness tier first
// (audit + brief: t5h before t12h before t24h before t5d), then by AI score
// descending. Ties broken by recency of `postedAt` then `discoveredAt`.

import { Domain } from '@apex/shared-types';
import type { JobPriorityManager } from './interfaces.js';
import type { DiscoveredJob } from '../types/discovery.js';

export class DefaultJobPriorityManager implements JobPriorityManager {
  prioritize(
    jobs: ReadonlyArray<DiscoveredJob & { aiScore?: number }>,
  ): ReadonlyArray<DiscoveredJob & { aiScore?: number }> {
    const out = [...jobs];
    out.sort((a, b) => {
      const fa = Domain.FRESHNESS_PRIORITY[a.freshness ?? 'stale'];
      const fb = Domain.FRESHNESS_PRIORITY[b.freshness ?? 'stale'];
      if (fa !== fb) return fa - fb;
      const sa = a.aiScore ?? 0;
      const sb = b.aiScore ?? 0;
      if (sa !== sb) return sb - sa;
      const pa = a.postedAt ? a.postedAt.getTime() : 0;
      const pb = b.postedAt ? b.postedAt.getTime() : 0;
      if (pa !== pb) return pb - pa;
      return 0;
    });
    return out;
  }
}
