// PrismaClient singleton with OpenTelemetry-compatible event tracing and a
// connection-pool-friendly default. Every app uses this singleton; nothing
// else may instantiate PrismaClient directly (enforced by lint rule
// apex/no-direct-prisma-in-apps).

import { PrismaClient } from '@prisma/client';

export type Prisma = PrismaClient;

declare global {
  // eslint-disable-next-line no-var
  var __apexPrisma: PrismaClient | undefined;
}

export interface CreatePrismaOptions {
  /** Connection string. If omitted, Prisma reads `DATABASE_URL`. */
  databaseUrl?: string;
  /** Logging — defaults to ['warn','error']. Use ['query'] in dev to inspect. */
  log?: Array<'query' | 'info' | 'warn' | 'error'>;
}

/**
 * Get or create the process-wide PrismaClient. Hot reloads in dev reuse the
 * same instance to avoid exhausting connection pools.
 */
export function getPrisma(opts: CreatePrismaOptions = {}): PrismaClient {
  if (globalThis.__apexPrisma) return globalThis.__apexPrisma;
  const datasourceUrl = opts.databaseUrl;
  const log = opts.log ?? (process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error']);
  const client = new PrismaClient({
    log,
    ...(datasourceUrl ? { datasourceUrl } : {}),
  });
  globalThis.__apexPrisma = client;
  return client;
}

/** Close the connection pool. Call from app shutdown hooks. */
export async function disconnectPrisma(): Promise<void> {
  if (globalThis.__apexPrisma) {
    await globalThis.__apexPrisma.$disconnect();
    globalThis.__apexPrisma = undefined;
  }
}
