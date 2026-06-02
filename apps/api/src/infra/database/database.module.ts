// DatabaseModule — provides PrismaClient + repositories via DI.
//
// Apps must NOT construct PrismaClient or repositories directly; they inject
// these tokens. This is the only place outside @apex/db that knows how to
// instantiate them.

import { Global, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import {
  AuditRepository,
  IdempotencyRepository,
  SessionRepository,
  UserRepository,
  disconnectPrisma,
  getPrisma,
  type PrismaClient,
} from '@apex/db';

export const PRISMA = Symbol('APEX_PRISMA');

export interface DatabaseModuleOptions {
  databaseUrl: string;
}

@Global()
@Module({})
export class DatabaseModule implements OnApplicationShutdown {
  static forRoot(opts: DatabaseModuleOptions): DynamicModule {
    const prisma: PrismaClient = getPrisma({ databaseUrl: opts.databaseUrl });
    return {
      module: DatabaseModule,
      providers: [
        { provide: PRISMA, useValue: prisma },
        { provide: UserRepository, useFactory: () => new UserRepository(prisma) },
        { provide: SessionRepository, useFactory: () => new SessionRepository(prisma) },
        { provide: AuditRepository, useFactory: () => new AuditRepository(prisma) },
        { provide: IdempotencyRepository, useFactory: () => new IdempotencyRepository(prisma) },
      ],
      exports: [PRISMA, UserRepository, SessionRepository, AuditRepository, IdempotencyRepository],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await disconnectPrisma();
  }
}
