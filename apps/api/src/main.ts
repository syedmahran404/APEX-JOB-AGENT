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
import { loadConfig } from '@apex/shared-config';
import { Env } from '@apex/shared-types';
import { AppModule } from './app.module.js';
import { disconnectPrisma } from '@apex/db';

async function bootstrap(): Promise<void> {
  const config = await loadConfig({
    schema: Env.ApiEnv,
    env: { ...process.env, SERVICE_NAME: 'apex-api' },
  });

  const adapter = new FastifyAdapter({
    trustProxy: true,
    logger: false, // we manage logging ourselves via Pino + interceptors
    bodyLimit: 1_048_576, // 1 MiB
  });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot({
      service: 'apex-api',
      version: config.SERVICE_VERSION,
      databaseUrl: config.DATABASE_URL,
      logLevel: config.LOG_LEVEL,
      pretty: config.NODE_ENV === 'development',
    }),
    adapter,
    {
      bufferLogs: true,
    },
  );

  app.enableShutdownHooks();

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

  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });

  // Graceful shutdown.
  const shutdown = (signal: NodeJS.Signals) => () => {
    void app
      .close()
      .then(() => disconnectPrisma())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
    // eslint-disable-next-line no-console
    console.warn('shutdown signal received:', signal);
  };
  process.on('SIGINT', shutdown('SIGINT'));
  process.on('SIGTERM', shutdown('SIGTERM'));

  await app.listen({ host: config.HOST, port: config.PORT });
  // eslint-disable-next-line no-console
  console.warn(
    `apex-api listening on ${config.HOST}:${String(config.PORT)} env=${config.NODE_ENV} version=${config.SERVICE_VERSION}`,
  );
}

bootstrap().catch((err: unknown) => {
  // We don't have a logger if loadConfig itself failed.
  // eslint-disable-next-line no-console
  console.error('Failed to bootstrap apex-api:', err);
  process.exit(1);
});
