import { Module, type DynamicModule } from '@nestjs/common';
import type { AiGateway } from '../gateway/gateway.js';
import { AiController, AI_GATEWAY } from './ai.controller.js';
import { HealthController } from './health.controller.js';

export interface AiModuleOptions {
  gateway: AiGateway;
  mode: 'mock' | 'live';
}

@Module({})
export class AiModule {
  static forRoot(opts: AiModuleOptions): DynamicModule {
    return {
      module: AiModule,
      controllers: [AiController, HealthController],
      providers: [
        { provide: AI_GATEWAY, useValue: opts.gateway },
        { provide: 'AI_MODE', useValue: opts.mode },
      ],
    };
  }
}
