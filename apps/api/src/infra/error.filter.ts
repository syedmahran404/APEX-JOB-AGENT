// Global exception filter. Maps every thrown value to an ErrorEnvelope.

import { Catch, type ArgumentsHost, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type Logger } from '@apex/shared-logger';
import {
  toEnvelope,
  type ApexError,
  RateLimitedError,
  isApexError,
  ValidationError,
} from '@apex/shared-errors';

@Catch()
export class ApexErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const req = ctx.getRequest<FastifyRequest>();

    let toSerialize: unknown = exception;

    // Normalize Nest's HttpException into something the envelope can carry.
    if (exception instanceof HttpException && !isApexError(exception)) {
      const body = exception.getResponse();
      const message = typeof body === 'string' ? body : (body as { message?: string }).message ?? exception.message;
      const fakeApex = {
        code: this.mapNestStatusToCode(exception.getStatus()),
        message,
        status: exception.getStatus(),
        details: undefined,
        traceId: undefined,
      } satisfies Partial<ApexError>;
      toSerialize = Object.setPrototypeOf({ ...fakeApex }, Error.prototype) as unknown as ApexError;
    }

    const traceId = (req.headers['x-trace-id'] as string | undefined) ?? undefined;
    const { status, envelope } = toEnvelope(toSerialize, traceId);

    // Rate-limit headers.
    if (toSerialize instanceof RateLimitedError) {
      void reply.header('Retry-After', toSerialize.retryAfterSec.toString());
    }

    // Logging policy: 5xx → error, 4xx → warn, 401/403 → info.
    const logFields = {
      status,
      code: envelope.error.code,
      method: req.method,
      url: req.url,
      ip: req.ip,
    };
    if (status >= 500) {
      this.logger.error({ err: exception, ...logFields }, 'request failed');
    } else if (status === 401 || status === 403) {
      this.logger.info(logFields, 'request rejected');
    } else if (toSerialize instanceof ValidationError) {
      this.logger.info({ ...logFields, issues: toSerialize.issues }, 'validation error');
    } else {
      this.logger.warn(logFields, 'request error');
    }

    void reply.status(status).send(envelope);
  }

  private mapNestStatusToCode(status: number): ApexError['code'] {
    switch (status) {
      case 400:
        return 'validation_error';
      case 401:
        return 'unauthenticated';
      case 403:
        return 'forbidden';
      case 404:
        return 'not_found';
      case 409:
        return 'conflict';
      case 412:
        return 'precondition_failed';
      case 429:
        return 'rate_limited';
      case 502:
      case 503:
      case 504:
        return 'dependency_unavailable';
      default:
        return 'internal_error';
    }
  }
}
