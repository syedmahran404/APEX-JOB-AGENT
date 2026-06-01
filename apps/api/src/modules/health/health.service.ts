import { Injectable } from '@nestjs/common';
import { type HealthCheckResponse } from '@apex/shared-types';
import { getPrisma } from '@apex/db';

export const HEALTH_SERVICE = Symbol('HEALTH_SERVICE');

@Injectable()
export class HealthService {
  private readonly startedAt = Date.now();

  async checkReadiness(): Promise<HealthCheckResponse> {
    const checks: HealthCheckResponse['checks'] = {};

    // PG ping.
    const t0 = performance.now();
    try {
      await getPrisma().$queryRawUnsafe('SELECT 1');
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
