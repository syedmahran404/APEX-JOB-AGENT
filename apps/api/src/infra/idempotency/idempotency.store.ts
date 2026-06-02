// IdempotencyStore implementation that bridges the interceptor to the
// @apex/db IdempotencyRepository. Redis hot-path cache is added in Phase 2;
// the PG-backed backstop already provides correctness.

import { Injectable, Inject } from '@nestjs/common';
import type { IdempotencyRepository } from '@apex/db';
import type { IdempotencyStore } from '../idempotency.interceptor.js';
import { LOGGER } from '../logger/logger.module.js';
import type { Logger } from '@apex/shared-logger';

@Injectable()
export class PrismaIdempotencyStore implements IdempotencyStore {
  // Default 7-day backstop in PG. Redis hot cache (24h) added in Phase 2.
  private static readonly TTL_SEC = 60 * 60 * 24 * 7;

  constructor(
    private readonly repo: IdempotencyRepository,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async recall(
    userId: string,
    key: string,
  ): Promise<{ status: number; envelope: Record<string, unknown> } | null> {
    const result = await this.repo.recall(userId, key);
    if (!result.hit || result.status === undefined || !result.envelope) return null;
    return { status: result.status, envelope: result.envelope };
  }

  async remember(input: {
    userId: string;
    key: string;
    method: string;
    path: string;
    requestBody: unknown;
    responseStatus: number;
    responseEnvelope: Record<string, unknown>;
  }): Promise<{ status: number; envelope: Record<string, unknown> } | null> {
    try {
      const result = await this.repo.remember({
        userId: input.userId,
        key: input.key,
        method: input.method,
        path: input.path,
        requestBody: input.requestBody,
        responseStatus: input.responseStatus,
        responseEnvelope: input.responseEnvelope,
        ttlSec: PrismaIdempotencyStore.TTL_SEC,
      });
      if (result.hit && result.status !== undefined && result.envelope) {
        return { status: result.status, envelope: result.envelope };
      }
      return null;
    } catch (err) {
      // IdempotencyMismatchError must propagate (409). Anything else: log and re-throw.
      const code = (err as { code?: string }).code;
      if (code !== 'idempotency_mismatch') {
        this.logger.warn({ err, key: input.key, userId: input.userId }, 'idempotency persistence failed');
      }
      throw err;
    }
  }
}
