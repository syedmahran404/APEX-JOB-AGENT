// Job repository. Discovery upserts jobs by (platform_id, external_id);
// canonical-key dedupe is handled separately via JobCanonicalKeyRepository.

import type { Job as PrismaJob, PrismaClient } from '@prisma/client';
import { NotFoundError } from '@apex/shared-errors';
import type { TxClient } from '../transactions.js';

export interface UpsertJobInput {
  tenantId: string;
  platformId: string;
  externalId: string;
  url: string;
  title: string;
  company?: string | null;
  location?: string | null;
  remoteKind?: 'remote' | 'hybrid' | 'onsite' | 'any' | null;
  postedAt?: Date | null;
  postedAtUncertain?: boolean;
  freshness?: 't5h' | 't12h' | 't24h' | 't5d' | 'stale' | null;
  descriptionMd?: string | null;
  raw?: Record<string, unknown> | null;
  applicants?: number | null;
  salaryMin?: bigint | null;
  salaryMax?: bigint | null;
  currency?: string | null;
  isQuickApply?: boolean | null;
  requiredSkills?: ReadonlyArray<string>;
  canonicalKey: string;
}

export class JobRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Upsert a job by (platform_id, external_id). On conflict, only mutable
   * fields are updated (title/company/description can drift over time, but
   * url + external_id never change).
   */
  async upsert(input: UpsertJobInput, tx?: TxClient): Promise<PrismaJob> {
    const client = (tx ?? (this.prisma as unknown as TxClient)) as unknown as PrismaClient;
    return client.job.upsert({
      where: {
        platformId_externalId: {
          platformId: input.platformId,
          externalId: input.externalId,
        },
      },
      create: {
        tenantId: input.tenantId,
        platformId: input.platformId,
        externalId: input.externalId,
        url: input.url,
        title: input.title,
        company: input.company ?? null,
        location: input.location ?? null,
        remoteKind: input.remoteKind ?? null,
        postedAt: input.postedAt ?? null,
        postedAtUncertain: input.postedAtUncertain ?? false,
        freshness: input.freshness ?? null,
        descriptionMd: input.descriptionMd ?? null,
        raw: (input.raw ?? null) as never,
        applicants: input.applicants ?? null,
        salaryMin: input.salaryMin ?? null,
        salaryMax: input.salaryMax ?? null,
        currency: input.currency ?? null,
        isQuickApply: input.isQuickApply ?? null,
        requiredSkills: [...(input.requiredSkills ?? [])],
        canonicalKey: input.canonicalKey,
      },
      update: {
        url: input.url,
        title: input.title,
        company: input.company ?? null,
        location: input.location ?? null,
        remoteKind: input.remoteKind ?? null,
        postedAt: input.postedAt ?? null,
        postedAtUncertain: input.postedAtUncertain ?? false,
        freshness: input.freshness ?? null,
        descriptionMd: input.descriptionMd ?? null,
        raw: (input.raw ?? null) as never,
        applicants: input.applicants ?? null,
        salaryMin: input.salaryMin ?? null,
        salaryMax: input.salaryMax ?? null,
        currency: input.currency ?? null,
        isQuickApply: input.isQuickApply ?? null,
        requiredSkills: [...(input.requiredSkills ?? [])],
        canonicalKey: input.canonicalKey,
      },
    });
  }

  async findById(id: string): Promise<PrismaJob | null> {
    return this.prisma.job.findUnique({ where: { id } });
  }

  async requireById(id: string): Promise<PrismaJob> {
    const j = await this.findById(id);
    if (!j) throw new NotFoundError('Job not found', { id });
    return j;
  }

  async findByPlatformExternal(platformId: string, externalId: string): Promise<PrismaJob | null> {
    return this.prisma.job.findUnique({
      where: { platformId_externalId: { platformId, externalId } },
    });
  }

  /**
   * Find another job (different platform) sharing the same canonical_key.
   * Used by the dedupe filter to skip cross-platform duplicates.
   */
  async findByCanonicalKey(canonicalKey: string): Promise<ReadonlyArray<PrismaJob>> {
    if (!canonicalKey) return [];
    return this.prisma.job.findMany({
      where: { canonicalKey },
      orderBy: { discoveredAt: 'asc' },
    });
  }
}
