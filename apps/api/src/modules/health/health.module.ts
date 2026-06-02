import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { HealthService, HEALTH_SERVICE } from './health.service.js';

@Module({
  controllers: [HealthController],
  providers: [{ provide: HEALTH_SERVICE, useClass: HealthService }],
})
export class HealthModule {}
