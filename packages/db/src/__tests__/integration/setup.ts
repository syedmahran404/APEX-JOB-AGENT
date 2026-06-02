// Shared setup for DB integration tests. Spins a single Testcontainers PG
// instance per test file (vitest's poolOptions.forks.singleFork keeps it serial).
//
// Each test file calls `await ensureSchema(prisma)` once in its `beforeAll`.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@prisma/client';

const execFileAsync = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPackageRoot = path.resolve(here, '..', '..', '..');

export interface IntegrationContext {
  container: StartedPostgreSqlContainer;
  prisma: PrismaClient;
  databaseUrl: string;
}

export async function startTestDb(): Promise<IntegrationContext> {
  const container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
    .withDatabase('apex_test')
    .withUsername('apex')
    .withPassword('apex')
    .withStartupTimeout(120_000)
    .start();
  const databaseUrl = container.getConnectionUri();

  // Apply migrations against the fresh DB.
  await execFileAsync('npx', ['prisma', 'migrate', 'deploy', `--schema=${path.join(dbPackageRoot, 'prisma', 'schema.prisma')}`], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    cwd: dbPackageRoot,
    maxBuffer: 16 * 1024 * 1024,
  });

  const prisma = new PrismaClient({ datasourceUrl: databaseUrl, log: ['error'] });
  return { container, prisma, databaseUrl };
}

export async function stopTestDb(ctx: IntegrationContext | null): Promise<void> {
  if (!ctx) return;
  await ctx.prisma.$disconnect();
  await ctx.container.stop({ removeVolumes: true });
}

export const TEST_TENANT_ID = '00000000-0000-0000-0000-000000000000';
