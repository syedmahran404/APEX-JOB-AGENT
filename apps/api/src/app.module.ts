import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from './infra/logger/logger.module.js';
import { DatabaseModule } from './infra/database/database.module.js';
import { IdempotencyModule } from './infra/idempotency/idempotency.module.js';
import { ApexErrorFilter } from './infra/error.filter.js';
import { HealthModule } from './modules/health/health.module.js';

export interface AppModuleOptions {
  service: string;
  version: string;
  databaseUrl: string;
  logLevel?: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  pretty?: boolean;
}

@Module({})
export class AppModule {
  static forRoot(opts: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot({
          service: opts.service,
          version: opts.version,
          level: opts.logLevel,
          pretty: opts.pretty,
        }),
        DatabaseModule.forRoot({ databaseUrl: opts.databaseUrl }),
        IdempotencyModule,
        HealthModule,
      ],
      providers: [
        {
          provide: APP_FILTER,
          useClass: ApexErrorFilter,
        },
      ],
    };
  }
}
