// User repository — the only path through which app code reads/writes users.
// All methods take an explicit `tenantId` so RLS retrofit (Phase 8) is mechanical.

import type { PrismaClient, User as PrismaUser } from '@prisma/client';
import { NotFoundError } from '@apex/shared-errors';
import type { TxClient } from '../transactions.js';

export interface CreateUserInput {
  tenantId: string;
  email: string;
  displayName: string;
  passwordHash: string;
  dataKeyId: string;
  dataKeyWrapped: Buffer;
}

export interface UpdateLoginStateInput {
  userId: string;
  succeeded: boolean;
  /** When succeeded, also bumps last_login_at and clears failed counter. */
}

export class UserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateUserInput, tx?: TxClient): Promise<PrismaUser> {
    const client = tx ?? (this.prisma);
    return (client as unknown as PrismaClient).user.create({
      data: {
        tenantId: input.tenantId,
        email: input.email,
        displayName: input.displayName,
        passwordHash: input.passwordHash,
        dataKeyId: input.dataKeyId,
        dataKeyWrapped: input.dataKeyWrapped,
      },
    });
  }

  async findByEmail(tenantId: string, email: string): Promise<PrismaUser | null> {
    return this.prisma.user.findFirst({
      where: { tenantId, email, deletedAt: null },
    });
  }

  async findById(tenantId: string, id: string): Promise<PrismaUser | null> {
    return this.prisma.user.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
  }

  async requireById(tenantId: string, id: string): Promise<PrismaUser> {
    const u = await this.findById(tenantId, id);
    if (!u) throw new NotFoundError('User not found', { id });
    return u;
  }

  async updateLoginState(input: UpdateLoginStateInput, tx?: TxClient): Promise<PrismaUser> {
    const client = (tx ?? (this.prisma)) as PrismaClient;
    if (input.succeeded) {
      return client.user.update({
        where: { id: input.userId },
        data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
      });
    }
    return client.user.update({
      where: { id: input.userId },
      data: { failedLoginCount: { increment: 1 } },
    });
  }

  /** Soft-delete the user; the reaper hard-deletes after grace. */
  async softDelete(userId: string, tx?: TxClient): Promise<void> {
    const client = (tx ?? (this.prisma)) as PrismaClient;
    await client.user.update({
      where: { id: userId },
      data: { deletedAt: new Date(), status: 'deleted' },
    });
  }
}
