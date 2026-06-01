// Platform account + credential + session + permission repositories.
// Bundled because they share lifecycle and the engine consumes them together.

import type {
  PlatformAccount as PrismaPlatformAccount,
  PlatformCredential as PrismaPlatformCredential,
  PlatformSession as PrismaPlatformSession,
  PlatformPermission as PrismaPlatformPermission,
  PlatformAccountStatus,
  SessionHealth,
  PrismaClient,
} from '@prisma/client';
import { NotFoundError } from '@apex/shared-errors';
import type { TxClient } from '../transactions.js';

export interface CreateOrUpdateCredentialInput {
  accountId: string;
  cipher: Buffer;
  cipherAadVersion: number;
  vaultKeyId: string;
  rotationVersion: number;
  dekVersion: number;
  expiresAt?: Date | null;
}

export class PlatformAccountRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listForUser(userId: string): Promise<ReadonlyArray<PrismaPlatformAccount>> {
    return this.prisma.platformAccount.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findByUserPlatform(
    userId: string,
    platformId: string,
  ): Promise<PrismaPlatformAccount | null> {
    return this.prisma.platformAccount.findUnique({
      where: { userId_platformId: { userId, platformId } },
    });
  }

  async requireByUserPlatform(userId: string, platformId: string): Promise<PrismaPlatformAccount> {
    const a = await this.findByUserPlatform(userId, platformId);
    if (!a) throw new NotFoundError('Platform account not connected', { userId, platformId });
    return a;
  }

  async setStatus(
    accountId: string,
    status: PlatformAccountStatus,
    tx?: TxClient,
  ): Promise<PrismaPlatformAccount> {
    const client = (tx ?? (this.prisma as unknown as TxClient)) as unknown as PrismaClient;
    return client.platformAccount.update({ where: { id: accountId }, data: { status } });
  }

  async markLastLogin(accountId: string, at: Date, tx?: TxClient): Promise<void> {
    const client = (tx ?? (this.prisma as unknown as TxClient)) as unknown as PrismaClient;
    await client.platformAccount.update({
      where: { id: accountId },
      data: { lastLoginAt: at, status: 'connected' },
    });
  }

  async markSessionCheck(accountId: string, at: Date, tx?: TxClient): Promise<void> {
    const client = (tx ?? (this.prisma as unknown as TxClient)) as unknown as PrismaClient;
    await client.platformAccount.update({
      where: { id: accountId },
      data: { lastSessionCheckAt: at },
    });
  }
}

export class PlatformCredentialRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async upsert(
    input: CreateOrUpdateCredentialInput,
    tx?: TxClient,
  ): Promise<PrismaPlatformCredential> {
    const client = (tx ?? (this.prisma as unknown as TxClient)) as unknown as PrismaClient;
    return client.platformCredential.upsert({
      where: { accountId: input.accountId },
      create: {
        accountId: input.accountId,
        cipher: input.cipher,
        cipherAadVersion: input.cipherAadVersion,
        vaultKeyId: input.vaultKeyId,
        rotationVersion: input.rotationVersion,
        dekVersion: input.dekVersion,
        expiresAt: input.expiresAt ?? null,
      },
      update: {
        cipher: input.cipher,
        cipherAadVersion: input.cipherAadVersion,
        vaultKeyId: input.vaultKeyId,
        rotationVersion: input.rotationVersion,
        dekVersion: input.dekVersion,
        rotatedAt: new Date(),
        expiresAt: input.expiresAt ?? null,
      },
    });
  }

  async findByAccountId(accountId: string): Promise<PrismaPlatformCredential | null> {
    return this.prisma.platformCredential.findUnique({ where: { accountId } });
  }

  async deleteByAccountId(accountId: string, tx?: TxClient): Promise<void> {
    const client = (tx ?? (this.prisma as unknown as TxClient)) as unknown as PrismaClient;
    await client.platformCredential.deleteMany({ where: { accountId } });
  }
}

export class PlatformSessionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(
    input: { accountId: string; storageUri: string; expiresAt?: Date | null; dekVersion?: number; health?: SessionHealth },
    tx?: TxClient,
  ): Promise<PrismaPlatformSession> {
    const client = (tx ?? (this.prisma as unknown as TxClient)) as unknown as PrismaClient;
    return client.platformSession.create({
      data: {
        accountId: input.accountId,
        storageUri: input.storageUri,
        expiresAt: input.expiresAt ?? null,
        dekVersion: input.dekVersion ?? 1,
        health: input.health ?? 'fresh',
      },
    });
  }

  async findLatestFresh(accountId: string): Promise<PrismaPlatformSession | null> {
    return this.prisma.platformSession.findFirst({
      where: { accountId, health: 'fresh', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      orderBy: { createdAt: 'desc' },
    });
  }

  async setHealth(
    sessionId: string,
    health: SessionHealth,
    tx?: TxClient,
  ): Promise<PrismaPlatformSession> {
    const client = (tx ?? (this.prisma as unknown as TxClient)) as unknown as PrismaClient;
    return client.platformSession.update({ where: { id: sessionId }, data: { health } });
  }

  async markUsed(sessionId: string, tx?: TxClient): Promise<void> {
    const client = (tx ?? (this.prisma as unknown as TxClient)) as unknown as PrismaClient;
    await client.platformSession.update({
      where: { id: sessionId },
      data: { lastUsedAt: new Date() },
    });
  }

  async markAllStaleForAccount(accountId: string, tx?: TxClient): Promise<number> {
    const client = (tx ?? (this.prisma as unknown as TxClient)) as unknown as PrismaClient;
    const r = await client.platformSession.updateMany({
      where: { accountId, health: 'fresh' },
      data: { health: 'stale' },
    });
    return r.count;
  }
}

export class PlatformPermissionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findForUserPlatform(
    userId: string,
    platformId: string,
  ): Promise<PrismaPlatformPermission | null> {
    return this.prisma.platformPermission.findUnique({
      where: { userId_platformId: { userId, platformId } },
    });
  }

  async getOrDefaults(userId: string, platformId: string): Promise<PrismaPlatformPermission> {
    const found = await this.findForUserPlatform(userId, platformId);
    if (found) return found;
    // Defaults match the schema column defaults; we synthesize an in-memory
    // record so the engine can read uniform values without an explicit row.
    const now = new Date();
    return {
      userId,
      platformId,
      allowApply: true,
      allowProfileEdit: false,
      allowResumeEdit: false,
      autonomousMode: 'assisted',
      dailyApplicationCap: null,
      thresholdScore: 70,
      pacingProfile: 'STRICT_DEFAULT',
      updatedAt: now,
    };
  }

  async listForUser(userId: string): Promise<ReadonlyArray<PrismaPlatformPermission>> {
    return this.prisma.platformPermission.findMany({ where: { userId } });
  }
}
