// Idempotency-key backstop. Redis is the hot path; this table covers ≥ 24h dedupe.
// Audit fix A4.

import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { IdempotencyMismatchError } from '@apex/shared-errors';
import type { TxClient } from '../transactions.js';

export interface RememberInput {
  userId: string;
  key: string;
  method: string;
  path: string;
  /** Canonical request body; we hash it. */
  requestBody: unknown;
  responseStatus: number;
  responseEnvelope: Record<string, unknown>;
  ttlSec: number;
}

export interface RecallResult {
  hit: boolean;
  status?: number;
  envelope?: Record<string, unknown>;
}

export class IdempotencyRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Attempt to remember a (user, key) → response. If an entry already exists:
   *   - request hash matches → return the stored response (replay).
   *   - request hash differs → throw IdempotencyMismatchError.
   */
  async remember(input: RememberInput, tx?: TxClient): Promise<RecallResult> {
    const client = (tx ?? (this.prisma)) as PrismaClient;
    const requestHash = this.hashRequest(input.requestBody);
    const expiresAt = new Date(Date.now() + input.ttlSec * 1000);

    try {
      await client.idempotencyKey.create({
        data: {
          userId: input.userId,
          key: input.key,
          method: input.method,
          path: input.path,
          requestHash,
          responseStatus: input.responseStatus,
          responseEnvelope: input.responseEnvelope as never,
          expiresAt,
        },
      });
      return { hit: false };
    } catch (err) {
      // Unique violation → existing entry; load and compare hashes.
      if ((err as { code?: string }).code !== 'P2002') throw err;
      const existing = await client.idempotencyKey.findUnique({
        where: { userId_key: { userId: input.userId, key: input.key } },
      });
      if (!existing) throw err;
      if (!Buffer.from(existing.requestHash).equals(requestHash)) {
        throw new IdempotencyMismatchError(input.key);
      }
      return {
        hit: true,
        status: existing.responseStatus,
        envelope: existing.responseEnvelope as Record<string, unknown>,
      };
    }
  }

  async recall(userId: string, key: string): Promise<RecallResult> {
    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { userId_key: { userId, key } },
    });
    if (!existing) return { hit: false };
    if (existing.expiresAt < new Date()) return { hit: false };
    return {
      hit: true,
      status: existing.responseStatus,
      envelope: existing.responseEnvelope as Record<string, unknown>,
    };
  }

  /** Reaper: delete expired entries. Returns the count. */
  async reapExpired(now: Date = new Date()): Promise<number> {
    const result = await this.prisma.idempotencyKey.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return result.count;
  }

  private hashRequest(body: unknown): Buffer {
    const json = JSON.stringify(body ?? null);
    return createHash('sha256').update(json, 'utf8').digest();
  }
}
