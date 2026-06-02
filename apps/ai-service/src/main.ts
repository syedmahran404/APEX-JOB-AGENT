// apps/ai-service bootstrap — the production AI gateway service.
//
// Order: load+validate env → compose engine (mock/live providers, registry,
// router, sink, gateway) → NestJS+Fastify → /healthz, /readyz, /api/v1/ai/* →
// listen → graceful shutdown.

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadConfig } from '@apex/shared-config';
import { disconnectPrisma } from '@apex/db';
import { AiServiceEnv } from './env.js';
import { composeEngine } from './composition.js';
import { AiModule } from './api/ai.module.js';

async function bootstrap(): Promise<void> {
  const config = await loadConfig({
    schema: AiServiceEnv,
    env: { ...process.env, SERVICE_NAME: 'apex-ai-service' },
  });

  const engine = composeEngine(config);

  const adapter = new FastifyAdapter({ trustProxy: true, logger: false, bodyLimit: 2_097_152 });
  const app = await NestFactory.create<NestFastifyApplication>(
    AiModule.forRoot({ gateway: engine.gateway, mode: engine.mode }),
    adapter,
    { bufferLogs: true },
  );
  app.enableShutdownHooks();
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });

  const shutdown = (signal: NodeJS.Signals) => (): void => {
    void app
      .close()
      .then(() => disconnectPrisma())
      .then(() => {
        process.exit(0);
      })
      .catch(() => {
        process.exit(1);
      });
    console.warn('apex-ai-service shutdown signal:', signal);
  };
  process.on('SIGINT', shutdown('SIGINT'));
  process.on('SIGTERM', shutdown('SIGTERM'));

  await app.listen({ host: config.HOST, port: config.PORT });
  console.warn(
    `apex-ai-service listening on ${config.HOST}:${String(config.PORT)} mode=${engine.mode} env=${config.NODE_ENV}`,
  );
}

bootstrap().catch((err: unknown) => {
  console.error('Failed to bootstrap apex-ai-service:', err);
  process.exit(1);
});
