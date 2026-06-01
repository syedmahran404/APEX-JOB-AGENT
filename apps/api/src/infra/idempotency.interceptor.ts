// Idempotency interceptor. On mutating routes, if the request carries
// `Idempotency-Key`, we either replay the prior response or, on cache miss,
// allow the handler to run and remember the result.
//
// In Phase 1 the API has no mutating endpoints yet (auth flows ship in Phase 2),
// so this interceptor is wired in but largely a no-op until those handlers
// land. The shape is locked so future controllers gain idempotency for free.

import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type Observable, of, from, switchMap } from 'rxjs';

export interface IdempotencyStore {
  /** Returns a cached envelope or null. */
  recall(userId: string, key: string): Promise<{ status: number; envelope: Record<string, unknown> } | null>;
  /** Persists a fresh response. Returns the cached envelope (after race) for replay. */
  remember(input: {
    userId: string;
    key: string;
    method: string;
    path: string;
    requestBody: unknown;
    responseStatus: number;
    responseEnvelope: Record<string, unknown>;
  }): Promise<{ status: number; envelope: Record<string, unknown> } | null>;
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly store: IdempotencyStore) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<FastifyRequest & { user?: { id: string } }>();
    const reply = http.getResponse<FastifyReply>();
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return next.handle();
    }
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0) return next.handle();
    const userId = req.user?.id;
    if (!userId) return next.handle();

    return from(this.store.recall(userId, key)).pipe(
      switchMap((cached) => {
        if (cached) {
          void reply.status(cached.status);
          return of(cached.envelope);
        }
        return next.handle().pipe(
          switchMap(async (body) => {
            const status = reply.statusCode;
            await this.store.remember({
              userId,
              key,
              method,
              path: req.url,
              requestBody: req.body ?? null,
              responseStatus: status,
              responseEnvelope: body as Record<string, unknown>,
            });
            return body;
          }),
        );
      }),
    );
  }
}
