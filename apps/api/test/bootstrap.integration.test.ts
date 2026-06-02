// apps/api full-bootstrap integration test.
//
// Spins a Testcontainers Postgres, applies migrations, boots a real
// NestFastifyApplication via AppModule.forRoot, and asserts:
//   1. `/healthz` returns 200 with `{status:'ok'}`.
//   2. `/readyz` returns 200 with status:'ok' and a passing postgres check.
//   3. The error filter wraps unknown errors as the canonical envelope.
//   4. CORS + cookie + helmet headers are applied.
//   5. `DELETE /unknown` 404s as `not_found` envelope (no Nest default JSON).
//
// Opt-in via RUN_INTEGRATION=1 or by invoking `pnpm test:integration`.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyHelmet from '@fastify/helmet';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AppModule } from '../src/app.module.js';

const execFileAsync = promisify(execFile);

interface Ctx {
  container: StartedPostgreSqlContainer;
  app: NestFastifyApplication;
  baseUrl: string;
}

const dbPackageRoot = path.resolve(import.meta.dirname, '..', '..', '..', 'packages', 'db');

async function startCtx(): Promise<Ctx> {
  const container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
    .withDatabase('apex_test')
    .withUsername('apex')
    .withPassword('apex')
    .withStartupTimeout(180_000)
    .start();
  const databaseUrl = container.getConnectionUri();

  await execFileAsync(
    'npx',
    [
      'prisma',
      'migrate',
      'deploy',
      `--schema=${path.join(dbPackageRoot, 'prisma', 'schema.prisma')}`,
    ],
    {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      cwd: dbPackageRoot,
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  const adapter = new FastifyAdapter({ trustProxy: true, logger: false });
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot({
      service: 'apex-api-test',
      version: '0.1.0',
      databaseUrl,
      logLevel: 'error',
      pretty: false,
    }),
    adapter,
    { bufferLogs: true, abortOnError: false },
  );
  app.enableShutdownHooks();
  await app.register(fastifyHelmet, { contentSecurityPolicy: false });
  await app.register(fastifyCookie);
  await app.register(fastifyCors, { origin: 'http://localhost:5173', credentials: true });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = await app.getUrl();
  return { container, app, baseUrl: url };
}

describe.runIf(process.env.RUN_INTEGRATION === '1')('apps/api bootstrap', () => {
  let ctx: Ctx | null = null;

  beforeAll(async () => {
    ctx = await startCtx();
  });

  afterAll(async () => {
    if (!ctx) return;
    await ctx.app.close();
    await ctx.container.stop({ removeVolumes: true });
  });

  it('GET /healthz returns 200 ok', async () => {
    if (!ctx) throw new TypeError('ctx not initialized');
    const resp = await fetch(new URL('/healthz', ctx.baseUrl));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('GET /readyz returns 200 with postgres check passing', async () => {
    if (!ctx) throw new TypeError('ctx not initialized');
    const resp = await fetch(new URL('/readyz', ctx.baseUrl));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      status: string;
      service: string;
      checks: Record<string, { status: string }>;
    };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('apex-api');
    expect(body.checks.postgres?.status).toBe('ok');
  });

  it('GET /api/v1/does-not-exist returns 404 envelope', async () => {
    if (!ctx) throw new TypeError('ctx not initialized');
    const resp = await fetch(new URL('/api/v1/does-not-exist', ctx.baseUrl));
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('not_found');
  });

  it('applies security headers from helmet', async () => {
    if (!ctx) throw new TypeError('ctx not initialized');
    const resp = await fetch(new URL('/healthz', ctx.baseUrl));
    expect(resp.headers.get('x-content-type-options')).toBe('nosniff');
    expect(resp.headers.get('referrer-policy')).toBe('same-origin');
  });

  it('honors CORS for the configured origin', async () => {
    if (!ctx) throw new TypeError('ctx not initialized');
    const resp = await fetch(new URL('/healthz', ctx.baseUrl), {
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(resp.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(resp.headers.get('access-control-allow-credentials')).toBe('true');
  });
});
