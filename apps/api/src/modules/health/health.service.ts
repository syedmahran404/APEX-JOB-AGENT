import { Inject, Injectable } from '@nestjs/common';
import { type HealthCheckResponse } from '@apex/shared-types';
import type { PrismaClient } from '@apex/db';
import { PRISMA } from '../../infra/database/database.module.js';

export const HEALTH_SERVICE = Symbol('HEALTH_SERVICE');

@Injectable()
export class HealthService {
  private readonly startedAt = Date.now();

  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async checkReadiness(): Promise<HealthCheckResponse> {
    const checks: HealthCheckResponse['checks'] = {};

    const t0 = performance.now();
    try {
      await this.prisma.$queryRawUnsafe('SELECT 1');
      checks.postgres = { status: 'ok', latencyMs: Math.round(performance.now() - t0) };
    } catch (err) {
      checks.postgres = { status: 'down', error: (err as Error).message };
    }

    const allOk = Object.values(checks).every((c) => c.status === 'ok');
    return {
      status: allOk ? 'ok' : 'down',
      service: 'apex-api',
      version: process.env.SERVICE_VERSION ?? '0.1.0',
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      checks,
    };
  }
}
