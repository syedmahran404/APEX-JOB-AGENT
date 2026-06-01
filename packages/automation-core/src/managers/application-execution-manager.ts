// ApplicationExecutionManager — drives one application end-to-end.
//
// Responsibilities:
//   1. Apply the per-application timeout (plan.maxDurationMs) by composing a
//      child AbortController with the engine-provided cancellation signal.
//   2. Invoke `adapter.apply()`.
//   3. Translate exceptions into a SubmitResult so the engine can persist
//      a clean status without unwinding through arbitrary errors.

import type { Logger } from '@apex/shared-logger';
import type { ApplicationExecutionManager } from './interfaces.js';
import type { AdapterContext, PlatformAdapter } from '../types/adapter.js';
import type { ApplicationPlan, JobDetail, SubmitResult } from '../types/discovery.js';
import { CancellationError } from '../types/errors.js';

export interface DefaultApplicationExecutionManagerOptions {
  logger: Logger;
}

export class DefaultApplicationExecutionManager implements ApplicationExecutionManager {
  private readonly logger: Logger;
  constructor(opts: DefaultApplicationExecutionManagerOptions) {
    this.logger = opts.logger.child({ component: 'application-execution-manager' });
  }

  async execute(input: {
    adapter: PlatformAdapter;
    ctx: AdapterContext;
    job: JobDetail;
    plan: ApplicationPlan;
  }): Promise<SubmitResult> {
    const { adapter, ctx, job, plan } = input;

    // Build a child controller chained to the engine's cancellation signal.
    // Either the parent cancellation OR the timeout fires the child.
    const child = new AbortController();
    const onParentAbort = (): void => child.abort('parent_cancelled');
    if (ctx.cancellation.aborted) {
      child.abort('parent_cancelled');
    } else {
      ctx.cancellation.addEventListener('abort', onParentAbort, { once: true });
    }
    const timer = setTimeout(() => child.abort('timeout'), plan.maxDurationMs);

    const scopedCtx: AdapterContext = { ...ctx, cancellation: child.signal };
    const t0 = Date.now();
    try {
      const result = await adapter.apply(scopedCtx, job, plan);
      this.logger.info(
        { applicationId: plan.applicationId, kind: result.kind, ms: Date.now() - t0 },
        'application completed',
      );
      return result;
    } catch (err) {
      if (child.signal.aborted && (child.signal.reason as string) === 'timeout') {
        this.logger.warn(
          { applicationId: plan.applicationId, ms: Date.now() - t0, max: plan.maxDurationMs },
          'application timed out',
        );
        return { kind: 'failed', reason: 'timeout', recoverable: true };
      }
      if (err instanceof CancellationError) throw err;
      throw err;
    } finally {
      clearTimeout(timer);
      ctx.cancellation.removeEventListener('abort', onParentAbort);
    }
  }
}
