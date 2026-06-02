// Queue consumers — registers BullMQ workers for the platform queues and routes
// each job (validated against the automation-core Zod task schemas) to its
// handler. The handlers are injected so this wiring is testable and the heavy
// browser work stays in the runners.
//
// Reference: docs/architecture/06-automation-engine.md §5.

import { QUEUES, ensureWorker, type BullConnections } from '@apex/queue';
import {
  parseDiscoveryTask,
  parseApplyTask,
  parseSessionRefreshTask,
  type DiscoveryTask,
  type ApplyTask,
  type SessionRefreshTask,
} from '@apex/automation-core';

/** The worker handle type, inferred from the queue helper (avoids a direct bullmq dep). */
export type RegisteredWorker = ReturnType<typeof ensureWorker>;

export interface TaskHandlers {
  onDiscovery(task: DiscoveryTask): Promise<void>;
  onApply(task: ApplyTask): Promise<void>;
  onSessionRefresh(task: SessionRefreshTask): Promise<void>;
}

export interface ConsumerOptions {
  connections: BullConnections;
  handlers: TaskHandlers;
  /** Max concurrent (user,platform) tasks this worker pod processes. */
  concurrency?: number;
}

/**
 * Register the three platform-queue workers. Each validates the job payload at
 * the boundary, so a malformed job throws (and BullMQ routes it to the DLQ after
 * retries). Returns the workers so the caller can close them on shutdown.
 */
export function registerConsumers(opts: ConsumerOptions): RegisteredWorker[] {
  const concurrency = opts.concurrency ?? 4;

  const discovery = ensureWorker<unknown>({
    name: QUEUES.PlatformDiscovery,
    connections: opts.connections,
    concurrency,
    handler: async (job) => {
      const task = parseDiscoveryTask(job.data);
      await opts.handlers.onDiscovery(task);
    },
  });

  const apply = ensureWorker<unknown>({
    name: QUEUES.PlatformApply,
    connections: opts.connections,
    concurrency,
    handler: async (job) => {
      const task = parseApplyTask(job.data);
      await opts.handlers.onApply(task);
    },
  });

  const sessionRefresh = ensureWorker<unknown>({
    name: QUEUES.PlatformSessionRefresh,
    connections: opts.connections,
    concurrency,
    handler: async (job) => {
      const task = parseSessionRefreshTask(job.data);
      await opts.handlers.onSessionRefresh(task);
    },
  });

  return [discovery, apply, sessionRefresh];
}
