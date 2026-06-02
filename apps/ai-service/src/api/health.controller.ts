import { Controller, Get, Inject } from '@nestjs/common';

@Controller()
export class HealthController {
  constructor(@Inject('AI_MODE') private readonly mode: 'mock' | 'live') {}

  @Get('healthz')
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  readiness(): { status: 'ok'; service: string; mode: 'mock' | 'live' } {
    return { status: 'ok', service: 'apex-ai-service', mode: this.mode };
  }
}
