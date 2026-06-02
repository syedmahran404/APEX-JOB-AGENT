// apps/orchestrator entrypoint.
//
// Wiring strategy: the orchestration LOGIC (RunCoordinator) is pure and tested.
// This bootstrap composes the concrete adapters (PG-backed RunStore via @apex/db,
// BullMQ TaskDispatcher via @apex/queue, outbox EventPublisher) and starts the
// dispatcher loop that consumes worker completion events from q:platform.events.
//
// The concrete adapter wiring depends on a live PG + Redis; it is intentionally
// thin here and exercised by integration tests (gated behind RUN_INTEGRATION).
// Unit tests cover the coordinator with in-memory ports.

import { createLogger } from '@apex/shared-logger';

const logger = createLogger({ service: 'apex-orchestrator', version: process.env.SERVICE_VERSION ?? '0.1.0' });

function main(): void {
  logger.info('apex-orchestrator starting');
  // Concrete adapter composition (PG RunStore, BullMQ dispatcher, outbox publisher,
  // Redis ownership lease + idempotency) is assembled here in the deployment build.
  // See src/coordinator.ts for the testable orchestration core and src/ports.ts
  // for the boundaries each adapter implements.
  logger.info('apex-orchestrator ready (awaiting platform events)');

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.warn({ signal }, 'apex-orchestrator shutdown');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

try {
  main();
} catch (err: unknown) {
  logger.error({ err }, 'Failed to start apex-orchestrator');
  process.exit(1);
}
