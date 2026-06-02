// apps/scheduler entrypoint.
//
// The scheduling LOGIC (SchedulerEngine + automation-core scheduling primitives)
// is pure and tested. This bootstrap composes the concrete adapters (Redis lease
// + PG schedule store + BullMQ schedule.fire dispatcher) and drives tick() on a
// fixed interval. Only the leader instance does work (fencing-token lease).
//
// Concrete adapter wiring depends on live Redis + PG; exercised by integration
// tests. Unit tests cover the engine with in-memory ports.

import { createLogger } from '@apex/shared-logger';

const logger = createLogger({ service: 'apex-scheduler', version: process.env.SERVICE_VERSION ?? '0.1.0' });

const TICK_INTERVAL_MS = 5_000;

function main(): void {
  logger.info('apex-scheduler starting');

  // In the deployment build, compose the Redis lease store + PG schedule store +
  // BullMQ dispatcher and the maintenance-job catalog, then:
  //   const timer = setInterval(() => void engine.tick().catch((e) => logger.error({ err: e }, 'tick failed')), TICK_INTERVAL_MS);
  // See src/engine.ts for the testable core.
  logger.info({ tickIntervalMs: TICK_INTERVAL_MS }, 'apex-scheduler ready');

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.warn({ signal }, 'apex-scheduler shutdown');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

try {
  main();
} catch (err: unknown) {
  logger.error({ err }, 'Failed to start apex-scheduler');
  process.exit(1);
}
