// User session repository.
// Storage convention: token_hash = SHA-256(session_id) so a leaked DB never
// surrenders live cookies.

import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient, UserSession as PrismaSession } from '@prisma/client';
import type { TxClient } from '../transactions.js';

export interface CreateSessionInput {
  userId: string;
  ttlSec: number;
  userAgent?: string;
  ipInet?: string;
}

export interface CreatedSession {
  id: string;
  /**
   * Plaintext session id for the cookie value. Never persisted server-side;
   * the DB keeps `SHA-256(session_id)`.
   */
  cookieSecret: string;
  expiresAt: Date;
}

export class SessionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateSessionInput, tx?: TxClient): Promise<CreatedSession> {
    const client = (tx ?? (this.prisma as unknown as TxClient)) as unknown as PrismaClient;
    const cookieSecret = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(cookieSecret, 'utf8').digest();
    const expiresAt = new Date(Date.now() + input.ttlSec * 1000);

    const row = await client.userSession.create({
      data: {
        userId: input.userId,
        tokenHash,
        userAgent: input.userAgent ?? null,
        ipInet: input.ipInet ?? null,
        expiresAt,
      },
    });
    return { id: row.id, cookieSecret, expiresAt };
  }

  async findByCookieSecret(cookieSecret: string): Promise<PrismaSession | null> {
    const tokenHash = createHash('sha256').update(cookieSecret, 'utf8').digest();
    const row = await this.prisma.userSession.findUnique({ where: { tokenHash } });
    if (!row) return null;
    if (row.revokedAt !== null) return null;
    if (row.expiresAt < new Date()) return null;
    return row;
  }

  async revoke(sessionId: string, tx?: TxClient): Promise<void> {
    const client = (tx ?? (this.prisma as unknown as TxClient)) as unknown as PrismaClient;
    await client.userSession.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(userId: string, tx?: TxClient): Promise<number> {
    const client = (tx ?? (this.prisma as unknown as TxClient)) as unknown as PrismaClient;
    const result = await client.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  async listActive(userId: string): Promise<ReadonlyArray<PrismaSession>> {
    return this.prisma.userSession.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
  }
}
