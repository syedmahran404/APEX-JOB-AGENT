// Testcontainers wrappers. The pgvector image ships with the extensions we
// need by default; pg_partman is added at the version we'll need in Phase 4.
//
// Usage:
//   const pg = await startPostgres({ migrationsDir: '../db/prisma/migrations' });
//   try { ... use pg.databaseUrl ... } finally { await pg.stop(); }

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

const execFileAsync = promisify(execFile);

export interface PostgresContainerOptions {
  /** Image to use. Defaults to pgvector/pgvector:pg16. */
  image?: string;
  /** Database name. Default 'apex_test'. */
  database?: string;
  /** When set, runs `prisma migrate deploy` against the started DB. */
  applyMigrationsFrom?: string;
}

export interface PostgresContainerHandle {
  databaseUrl: string;
  host: string;
  port: number;
  stop: () => Promise<void>;
  raw: StartedPostgreSqlContainer;
}

export async function startPostgres(opts: PostgresContainerOptions = {}): Promise<PostgresContainerHandle> {
  const container = await new PostgreSqlContainer(opts.image ?? 'pgvector/pgvector:pg16')
    .withDatabase(opts.database ?? 'apex_test')
    .withUsername('apex')
    .withPassword('apex')
    .withStartupTimeout(60_000)
    .start();

  const databaseUrl = container.getConnectionUri();

  if (opts.applyMigrationsFrom) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const schemaArg = path.resolve(here, opts.applyMigrationsFrom, '..', 'schema.prisma');
    await execFileAsync('npx', ['prisma', 'migrate', 'deploy', `--schema=${schemaArg}`], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      cwd: path.resolve(here, '..'),
    });
  }

  return {
    databaseUrl,
    host: container.getHost(),
    port: container.getMappedPort(5432),
    raw: container,
    async stop(): Promise<void> {
      await container.stop({ removeVolumes: true });
    },
  };
}
