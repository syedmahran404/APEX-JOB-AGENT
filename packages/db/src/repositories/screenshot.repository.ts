// Screenshot repository. Files themselves live in object storage; we record
// references with the redaction state.

import type { PrismaClient, Screenshot as PrismaScreenshot } from '@prisma/client';
import type { TxClient } from '../transactions.js';

export interface CreateScreenshotInput {
  tenantId: string;
  userId: string;
  applicationId?: string | null;
  runId?: string | null;
  platformId?: string | null;
  kind: string;
  uri: string;
  redacted: boolean;
  bytes?: bigint | null;
  sha256?: Buffer | null;
  label?: string | null;
}

export class ScreenshotRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateScreenshotInput, tx?: TxClient): Promise<PrismaScreenshot> {
    const client = (tx ?? (this.prisma as unknown as TxClient)) as unknown as PrismaClient;
    return client.screenshot.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        applicationId: input.applicationId ?? null,
        runId: input.runId ?? null,
        platformId: input.platformId ?? null,
        kind: input.kind,
        uri: input.uri,
        redacted: input.redacted,
        bytes: input.bytes ?? null,
        sha256: input.sha256 ?? null,
        label: input.label ?? null,
      },
    });
  }

  async listForApplication(applicationId: string): Promise<ReadonlyArray<PrismaScreenshot>> {
    return this.prisma.screenshot.findMany({
      where: { applicationId },
      orderBy: { capturedAt: 'asc' },
    });
  }
}
