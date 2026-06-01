// JobFilteringManager — drops candidates that:
//   1. Fall below the user's threshold score (skipped_low_score).
//   2. Have freshness === 'stale' when rejectStale is true (skipped_stale).
//   3. The user has already applied to (live application exists; skipped_duplicate).
//   4. Share a canonical_key with another platform's already-applied job
//      (audit fix C1; skipped_duplicate).

import type { ApplicationRepository, JobCanonicalKeyRepository, JobRepository } from '@apex/db';
import type { Logger } from '@apex/shared-logger';
import type { JobFilteringManager } from './interfaces.js';
import type { DiscoveredJob } from '../types/discovery.js';

export interface DefaultJobFilteringManagerOptions {
  logger: Logger;
  applicationRepo: ApplicationRepository;
  jobRepo: JobRepository;
  canonicalRepo: JobCanonicalKeyRepository;
}

export class DefaultJobFilteringManager implements JobFilteringManager {
  private readonly logger: Logger;
  constructor(private readonly opts: DefaultJobFilteringManagerOptions) {
    this.logger = opts.logger.child({ component: 'job-filtering-manager' });
  }

  async filter(input: {
    userId: string;
    tenantId: string;
    platformId: string;
    candidates: ReadonlyArray<DiscoveredJob & { aiScore?: number }>;
    thresholdScore: number;
    rejectStale: boolean;
  }): Promise<{
    kept: ReadonlyArray<DiscoveredJob & { aiScore?: number }>;
    rejected: ReadonlyArray<{ job: DiscoveredJob; reason: string }>;
  }> {
    const kept: Array<DiscoveredJob & { aiScore?: number }> = [];
    const rejected: Array<{ job: DiscoveredJob; reason: string }> = [];

    for (const c of input.candidates) {
      const score = c.aiScore ?? 0;
      if (score < input.thresholdScore) {
        rejected.push({ job: c, reason: `score:${score.toString()}<${input.thresholdScore.toString()}` });
        continue;
      }
      if (input.rejectStale && c.freshness === 'stale') {
        rejected.push({ job: c, reason: 'stale' });
        continue;
      }

      // Cross-platform dedupe via canonical_key.
      if (c.canonicalKey.length > 0) {
        const variants = await this.opts.jobRepo.findByCanonicalKey(c.canonicalKey);
        if (variants.length > 0) {
          let blocking = false;
          for (const v of variants) {
            const live = await this.opts.applicationRepo.findActiveForUserJob(input.userId, v.id);
            if (live) {
              blocking = true;
              break;
            }
          }
          if (blocking) {
            rejected.push({ job: c, reason: 'duplicate_cross_platform' });
            continue;
          }
        }
      }

      // Same-platform dedupe via existing job row + active application.
      const existingJob = await this.opts.jobRepo.findByPlatformExternal(input.platformId, c.externalId);
      if (existingJob) {
        const live = await this.opts.applicationRepo.findActiveForUserJob(input.userId, existingJob.id);
        if (live) {
          rejected.push({ job: c, reason: 'duplicate_same_platform' });
          continue;
        }
      }

      kept.push(c);
    }

    this.logger.info(
      { kept: kept.length, rejected: rejected.length, threshold: input.thresholdScore },
      'filter complete',
    );
    return { kept, rejected };
  }
}
