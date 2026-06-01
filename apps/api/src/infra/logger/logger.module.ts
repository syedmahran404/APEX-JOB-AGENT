// LoggerModule — provides the project-wide Pino logger via DI.
// Constructed once at the AppModule level using the validated config.

import { Global, Module, type DynamicModule } from '@nestjs/common';
import { createLogger, type Logger } from '@apex/shared-logger';

export const LOGGER = Symbol('APEX_LOGGER');

export interface LoggerModuleOptions {
  service: string;
  version: string;
  level?: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  pretty?: boolean;
}

@Global()
@Module({})
export class LoggerModule {
  static forRoot(opts: LoggerModuleOptions): DynamicModule {
    const logger: Logger = createLogger(opts);
    return {
      module: LoggerModule,
      providers: [
        {
          provide: LOGGER,
          useValue: logger,
        },
      ],
      exports: [LOGGER],
    };
  }
}
