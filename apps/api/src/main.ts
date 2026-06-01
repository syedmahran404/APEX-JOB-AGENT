// apps/api bootstrap.
//
// Order of operations:
//   1. Load + validate env (crash-fast on misconfig).
//   2. Create logger.
//   3. Create the Nest app with the Fastify adapter.
//   4. Wire global pipes / filters / interceptors.
//   5. Configure security headers, CORS, cookies.
//   6. Bind /healthz and /readyz.
//   7. Listen.
//   8. Graceful shutdown on SIGTERM / SIGINT.

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyHelmet from '@fastify/helmet';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import { createLogger } from '@apex/shared-logger';
import { loadConfig } from '@apex/shared-config';
import { Env } from '@apex/shared-types';
import { AppModule } from './app.module.js';
import { ApexErrorFilter } from './infra/error.filter.js';
import { disconnectPrisma } from '@apex/db';

async function bootstrap(): Promise<void> {
  const config = await loadConfig({
    schema: Env.ApiEnv,
    env: { ...process.env, SERVICE_NAME: 'apex-api' },
  });

  const logger = createLogger({
    service: 'apex-api',
    version: config.SERVICE_VERSION,
    level: config.LOG_LEVEL,
    pretty: config.NODE_ENV === 'development',
  });

  const adapter = new FastifyAdapter({
    trustProxy: true,
    logger: false, // we manage logging ourselves via Pino + interceptors
    bodyLimit: 1_048_576, // 1 MiB
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
  });

  // Security headers.
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: false, // CSP is set per-route on the SPA shell, not here
    referrerPolicy: { policy: 'same-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });

  await app.register(fastifyCookie);

  await app.register(fastifyCors, {
    origin: config.CORS_ORIGIN,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Idempotency-Key', 'X-CSRF-Token'],
    exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  app.useGlobalFilters(new ApexErrorFilter(logger));

  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });

  // Graceful shutdown.
  const shutdown = (signal: NodeJS.Signals) => () => {
    logger.info({ signal }, 'received shutdown signal');
    void app
      .close()
      .then(() => disconnectPrisma())
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        logger.error({ err }, 'error during shutdown');
        process.exit(1);
      });
  };
  process.on('SIGINT', shutdown('SIGINT'));
  process.on('SIGTERM', shutdown('SIGTERM'));

  await app.listen({ host: config.HOST, port: config.PORT });
  logger.info(
    { host: config.HOST, port: config.PORT, env: config.NODE_ENV, version: config.SERVICE_VERSION },
    'apex-api listening',
  );
}

bootstrap().catch((err: unknown) => {
  // We don't have a logger if loadConfig itself failed.
  // eslint-disable-next-line no-console
  console.error('Failed to bootstrap apex-api:', err);
  process.exit(1);
});
