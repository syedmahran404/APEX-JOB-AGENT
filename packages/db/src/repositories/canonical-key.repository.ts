// JobCanonicalKey repository. Insert-or-bump-counter on each new variant.

import type { JobCanonicalKey as PrismaCanonicalKey, PrismaClient } from '@prisma/client';
import type { TxClient } from '../transactions.js';

export class JobCanonicalKeyRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Register a sighting of canonical_key. Returns the representative job id. */
  async register(canonicalKey: string, jobId: string, tx?: TxClient): Promise<PrismaCanonicalKey> {
    if (!canonicalKey) {
      throw new TypeError('canonical_key required');
    }
    const client = (tx ?? (this.prisma as unknown as TxClient)) as unknown as PrismaClient;
    return client.jobCanonicalKey.upsert({
      where: { canonicalKey },
      create: { canonicalKey, representativeJobId: jobId },
      update: { variantCount: { increment: 1 } },
    });
  }

  async findByKey(canonicalKey: string): Promise<PrismaCanonicalKey | null> {
    return this.prisma.jobCanonicalKey.findUnique({ where: { canonicalKey } });
  }
}
