// JobUpserter — bridges DiscoveredJob[] → @apex/db Job[].
// Also registers each canonical key for cross-platform dedupe.

import { type Job, type JobCanonicalKeyRepository, type JobRepository, runInTransaction, type PrismaClient } from '@apex/db';
import type { JobUpserter } from './interfaces.js';
import type { DiscoveredJob } from '../types/discovery.js';

export interface DefaultJobUpserterOptions {
  prisma: PrismaClient;
  jobRepo: JobRepository;
  canonicalRepo: JobCanonicalKeyRepository;
}

export class DefaultJobUpserter implements JobUpserter {
  constructor(private readonly opts: DefaultJobUpserterOptions) {}

  async upsertMany(input: {
    tenantId: string;
    platformId: string;
    discovered: ReadonlyArray<DiscoveredJob>;
  }): Promise<ReadonlyArray<Job>> {
    if (input.discovered.length === 0) return [];
    return runInTransaction(this.opts.prisma, async (tx) => {
      const out: Job[] = [];
      for (const d of input.discovered) {
        const job = await this.opts.jobRepo.upsert(
          {
            tenantId: input.tenantId,
            platformId: input.platformId,
            externalId: d.externalId,
            url: d.url,
            title: d.title,
            company: d.company,
            location: d.location,
            remoteKind: d.remoteKind,
            postedAt: d.postedAt,
            postedAtUncertain: d.postedAtUncertain,
            freshness: d.freshness,
            descriptionMd: null,
            applicants: d.applicants,
            salaryMin: d.salaryMin,
            salaryMax: d.salaryMax,
            currency: d.currency,
            isQuickApply: d.isQuickApply,
            requiredSkills: d.requiredSkills,
            canonicalKey: d.canonicalKey,
          },
          tx,
        );
        if (d.canonicalKey.length > 0) {
          await this.opts.canonicalRepo.register(d.canonicalKey, job.id, tx);
        }
        out.push(job);
      }
      return out;
    });
  }
}
