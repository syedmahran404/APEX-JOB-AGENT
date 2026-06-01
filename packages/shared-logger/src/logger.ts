// Pino logger factory with project-wide defaults: JSON to stdout, PII redaction,
// trace-id correlation when @opentelemetry/api is loaded by the host process.
//
// We do not import OTel here as a hard dep; we use the global `trace` API if
// available (@opentelemetry/api is a singleton).

import pino, { type Logger as PinoLogger, type LoggerOptions as PinoLoggerOptions } from 'pino';
import { REDACT_PATHS, REDACTED, scrubEnvelopedFields } from './redaction.js';

export interface LogContext {
  traceId?: string;
  spanId?: string;
  userId?: string;
  tenantId?: string;
  runId?: string;
  applicationId?: string;
  service?: string;
  [k: string]: unknown;
}

export type Logger = PinoLogger;

export interface LoggerOptions {
  /** Logical service name (`apex-api`, `apex-orchestrator`, …). */
  service: string;
  /** Service version (e.g. from package.json). */
  version: string;
  /** Pino level. */
  level?: pino.LevelWithSilent;
  /** When true, emits human-readable output (development only). */
  pretty?: boolean;
  /** Bind extra context to every line. */
  base?: Record<string, unknown>;
}

/**
 * Best-effort OTel trace context extraction. Optional dependency — we only call
 * it if @opentelemetry/api is in the host's module graph.
 */
function readActiveSpan(): { traceId?: string; spanId?: string } {
  try {
    // dynamic require so the dependency stays optional
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const otel = require('@opentelemetry/api') as typeof import('@opentelemetry/api');
    const ctx = otel.context.active();
    const span = otel.trace.getSpan(ctx);
    if (!span) return {};
    const sc = span.spanContext();
    return { traceId: sc.traceId, spanId: sc.spanId };
  } catch {
    return {};
  }
}

export function createLogger(opts: LoggerOptions): Logger {
  const baseOptions: PinoLoggerOptions = {
    level: opts.level ?? (process.env.LOG_LEVEL as pino.LevelWithSilent) ?? 'info',
    base: {
      service: opts.service,
      version: opts.version,
      ...opts.base,
    },
    redact: {
      paths: [...REDACT_PATHS],
      censor: REDACTED,
      remove: false,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
      bindings: (b) => b,
    },
    mixin() {
      const { traceId, spanId } = readActiveSpan();
      const out: Record<string, unknown> = {};
      if (traceId) out.traceId = traceId;
      if (spanId) out.spanId = spanId;
      return out;
    },
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
      req: pino.stdSerializers.req,
      res: pino.stdSerializers.res,
    },
    hooks: {
      logMethod(args, method) {
        // Strip *_enc / *_wrapped keys recursively from any object payload.
        if (args.length >= 1 && typeof args[0] === 'object' && args[0] !== null) {
          args[0] = scrubEnvelopedFields(args[0]) as Record<string, unknown>;
        }
        return method.apply(this, args);
      },
    },
  };

  if (opts.pretty === true) {
    return pino(
      baseOptions,
      pino.transport({
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard', singleLine: false },
      }),
    );
  }
  return pino(baseOptions);
}

/** Bind LogContext fields to a logger and return the child. */
export function withChildContext(logger: Logger, ctx: LogContext): Logger {
  return logger.child(ctx);
}
