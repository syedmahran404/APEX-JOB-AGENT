// apps/automation-worker entrypoint.
//
// Composition: launches a PlaywrightBrowserDriver-backed PooledBrowserManager,
// redeems credential leases just-in-time, drives platform flows via the runtime
// adapters, captures screenshots, and reports ApplyEvents — all behind the
// queue consumers. The browser/queue/vault wiring needs a live Chromium + Redis
// and is exercised by integration tests; unit tests cover the runners, pool,
// adapter runtime, and consumers with fakes.

import { createLogger } from '@apex/shared-logger';

const logger = createLogger({ service: 'apex-automation-worker', version: process.env.SERVICE_VERSION ?? '0.1.0' });

function main(): void {
  logger.info('apex-automation-worker starting');

  // Deployment build composes:
  //   - PooledBrowserManager({ driver: new PlaywrightBrowserDriver(), store, provisioner })
  //   - ScreenshotCapturer({ store: s3, sensitiveSelectors })
  //   - LinkedInRuntimeAdapter per acquired page
  //   - ApplyRunner({ adapter, reporter, screenshots, page, answer })
  //   - registerConsumers({ connections: createBullConnection(...), handlers })
  // and wires graceful shutdown to close workers + pool.
  logger.info('apex-automation-worker ready (draining platform queues)');

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.warn({ signal }, 'apex-automation-worker shutdown');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

try {
  main();
} catch (err: unknown) {
  logger.error({ err }, 'Failed to start apex-automation-worker');
  process.exit(1);
}
