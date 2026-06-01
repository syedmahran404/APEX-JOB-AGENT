// IdempotencyModule — wires the IdempotencyInterceptor as a global interceptor
// using the PrismaIdempotencyStore (PG-backed backstop). Redis hot path is
// added in Phase 2 (the store interface is unchanged).

import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { IdempotencyInterceptor, type IdempotencyStore } from '../idempotency.interceptor.js';
import { PrismaIdempotencyStore } from './idempotency.store.js';

export const IDEMPOTENCY_STORE = Symbol('APEX_IDEMPOTENCY_STORE');

@Module({
  providers: [
    PrismaIdempotencyStore,
    { provide: IDEMPOTENCY_STORE, useExisting: PrismaIdempotencyStore },
    {
      provide: APP_INTERCEPTOR,
      useFactory: (store: IdempotencyStore) => new IdempotencyInterceptor(store),
      inject: [IDEMPOTENCY_STORE],
    },
  ],
  exports: [IDEMPOTENCY_STORE],
})
export class IdempotencyModule {}
