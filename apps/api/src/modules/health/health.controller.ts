// Liveness & readiness endpoints (audit fix G3).
// /healthz: process is alive. Always 200 if reachable.
// /readyz:  PG, Redis, Vault reachable. Returns 503 with details otherwise.

import { Controller, Get, Inject, Res } from '@nestjs/common';
import { type FastifyReply } from 'fastify';
import type { Api } from '@apex/shared-types';
import type { HealthService} from './health.service.js';
import { HEALTH_SERVICE } from './health.service.js';

@Controller()
export class HealthController {
  constructor(@Inject(HEALTH_SERVICE) private readonly health: HealthService) {}

  @Get('healthz')
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  async readiness(@Res({ passthrough: true }) reply: FastifyReply): Promise<Api.HealthCheckResponse> {
    const result = await this.health.checkReadiness();
    if (result.status !== 'ok') {
      void reply.status(503);
    }
    return result;
  }
}
