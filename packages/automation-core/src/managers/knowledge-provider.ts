// KnowledgeProvider — loads what the adapter needs (frequent answers +
// profile slice) before each stage.
//
// Phase 2 implementation: profile slice is synthesized from the User row
// (+ run config) because the user_profiles + frequent_answers tables ship
// in a later phase. The interface stays the same; replacing the
// implementation is the only change downstream.

import type { PrismaClient, User } from '@apex/db';
import type { Logger } from '@apex/shared-logger';
import { NotFoundError } from '@apex/shared-errors';
import type { KnowledgeProvider } from '../engine/base-engine.js';
import type { AdapterKnowledge, AdapterProfileSlice } from '../types/adapter.js';

export interface DefaultKnowledgeProviderOptions {
  logger: Logger;
  prisma: PrismaClient;
  /** Defaults applied when no profile row exists (e.g., new user). */
  defaults?: Partial<AdapterProfileSlice>;
}

export class DefaultKnowledgeProvider implements KnowledgeProvider {
  private readonly logger: Logger;
  constructor(private readonly opts: DefaultKnowledgeProviderOptions) {
    this.logger = opts.logger.child({ component: 'knowledge-provider' });
  }

  async load(userId: string, _tenantId: string): Promise<AdapterKnowledge> {
    void _tenantId;
    // Phase 2: empty frequent_answers map. Phase 6 wires the table.
    const frequentAnswers = new Map();
    const profile = await this.loadProfile(userId, _tenantId);
    return { frequentAnswers, profile };
  }

  async loadProfile(userId: string, _tenantId: string): Promise<AdapterProfileSlice> {
    void _tenantId;
    const user: User | null = await this.opts.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError('User not found', { userId });
    const d = this.opts.defaults ?? {};
    return {
      displayName: user.displayName,
      headline: d.headline ?? null,
      summary: d.summary ?? null,
      currentTitle: d.currentTitle ?? null,
      currentCompany: d.currentCompany ?? null,
      totalExperienceMonths: d.totalExperienceMonths ?? null,
      noticePeriodDays: d.noticePeriodDays ?? null,
      willingToRelocate: d.willingToRelocate ?? null,
      preferredCurrency: d.preferredCurrency ?? null,
      expectedSalaryMin: d.expectedSalaryMin ?? null,
      expectedSalaryMax: d.expectedSalaryMax ?? null,
      preferredLocations: d.preferredLocations ?? [],
    };
  }
}
