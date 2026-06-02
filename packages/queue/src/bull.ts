// BullMQ Queue/Worker helpers. We keep BullMQ option construction in one place
// so retries, ack semantics, and DLQ behavior are uniform.

import { Queue, Worker, type ConnectionOptions, type Job, type WorkerOptions } from 'bullmq';
import { dlqName, DEFAULT_RETRY_POLICY, type QueueName } from './queues.js';
import { type BullConnections } from './connection.js';

export type WorkerHandler<TPayload, TResult = unknown> = (
  job: Job<TPayload, TResult>,
) => Promise<TResult>;

export interface EnsureQueueOptions {
  name: QueueName;
  connections: BullConnections;
}

export function ensureQueue<TPayload>(opts: EnsureQueueOptions): Queue<TPayload> {
  const conn: ConnectionOptions = opts.connections.client;
  const q = new Queue<TPayload>(opts.name, {
    connection: conn,
    defaultJobOptions: { ...DEFAULT_RETRY_POLICY },
  });
  return q;
}

export interface EnsureWorkerOptions<TPayload, TResult = unknown> {
  name: QueueName;
  connections: BullConnections;
  handler: WorkerHandler<TPayload, TResult>;
  concurrency?: number;
  /** Stalled detection interval in ms. Default 30_000. */
  stalledInterval?: number;
  /** Optional worker options passthrough. */
  options?: Omit<WorkerOptions, 'connection'>;
}

export function ensureWorker<TPayload, TResult = unknown>(
  opts: EnsureWorkerOptions<TPayload, TResult>,
): Worker<TPayload, TResult> {
  const worker = new Worker<TPayload, TResult>(
    opts.name,
    async (job): Promise<TResult> => opts.handler(job),
    {
      connection: opts.connections.blocking,
      concurrency: opts.concurrency ?? 1,
      stalledInterval: opts.stalledInterval ?? 30_000,
      ...opts.options,
    },
  );
  return worker;
}

/** Move an already-failed job into the DLQ with reason context. */
export async function moveToDlq<TPayload>(
  job: Job<TPayload>,
  reason: string,
  connections: BullConnections,
): Promise<void> {
  // Type the DLQ with a concrete (non-generic) data type so BullMQ's
  // ExtractNameType resolves the job-name parameter to `string`. A free type
  // parameter in the Queue's data type leaves that conditional type unresolved.
  const dlq = new Queue<Record<string, unknown>>(dlqName(job.queueName as QueueName), {
    connection: connections.client,
  });
  try {
    const message: Record<string, unknown> = {
      ...(job.data as unknown as Record<string, unknown>),
      __dlq: { fromQueue: job.queueName, reason, failedAt: new Date().toISOString() },
    };
    await dlq.add('dead-letter', message, { removeOnComplete: true });
  } finally {
    await dlq.close();
  }
}
