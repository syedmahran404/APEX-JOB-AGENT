// QueueManager — wraps the BullMQ queue for run dispatch.

import { Queue } from 'bullmq';
import type { Logger } from '@apex/shared-logger';
import { DEFAULT_RETRY_POLICY, QUEUES, type BullConnections } from '@apex/queue';
import type { QueueManager } from './interfaces.js';

export const RUN_QUEUE = 'q:run.execute' as const;

export interface RunTaskPayload {
  runId: string;
  /** Worker replica that should pick this up; null = any. */
  preferredReplica: string | null;
}

export interface DefaultQueueManagerOptions {
  logger: Logger;
  connections: BullConnections;
}

export class DefaultQueueManager implements QueueManager {
  private readonly logger: Logger;
  private readonly queue: Queue<RunTaskPayload>;

  constructor(opts: DefaultQueueManagerOptions) {
    this.logger = opts.logger.child({ component: 'queue-manager' });
    this.queue = new Queue<RunTaskPayload>(RUN_QUEUE, {
      connection: opts.connections.client,
      defaultJobOptions: { ...DEFAULT_RETRY_POLICY },
    });
    // Reference QUEUES so the symbol stays exported and surfaces in autocomplete.
    void QUEUES;
  }

  async enqueueRun(runId: string, opts: { delayMs?: number } = {}): Promise<void> {
    const job = await this.queue.add(
      'run.execute',
      { runId, preferredReplica: null },
      {
        ...(opts.delayMs ? { delay: opts.delayMs } : {}),
        jobId: `run:${runId}`,
      },
    );
    this.logger.info({ runId, jobId: job.id }, 'enqueued run.execute');
  }

  async shutdown(): Promise<void> {
    await this.queue.close();
  }
}
