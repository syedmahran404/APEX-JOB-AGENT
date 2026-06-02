// Shared Redis connection factory for BullMQ. We use ioredis under the hood
// (BullMQ's required client). Callers pass the Redis URL; `createBullConnection`
// returns a tuple of `(producerClient, subscriberClient, blockingClient)` —
// BullMQ requires three logical clients per worker (one per role).

import { Redis, type RedisOptions } from 'ioredis';

export interface BullConnectionOptions {
  /** Redis URL: `redis://[user[:pass]]@host:port[/db]`. */
  url: string;
  /** Optional logical name for diagnostics. */
  clientName?: string;
  /** Default 10s. */
  connectTimeoutMs?: number;
  /** Allowlist of Redis options to override (advanced). */
  redisOptionsOverride?: Partial<RedisOptions>;
}

export interface BullConnections {
  /** For Queue & QueueEvents (publish + non-blocking commands). */
  client: Redis;
  /** Subscriber client (BullMQ uses this for queue-event subscriptions). */
  subscriber: Redis;
  /** Blocking client (workers BLPOP loop). */
  blocking: Redis;
  close(): Promise<void>;
}

function makeClient(opts: BullConnectionOptions, role: string): Redis {
  const baseOptions: RedisOptions = {
    connectionName: `${opts.clientName ?? 'apex'}:${role}`,
    connectTimeout: opts.connectTimeoutMs ?? 10_000,
    maxRetriesPerRequest: null,        // BullMQ requirement for blocking client
    enableReadyCheck: false,
    ...opts.redisOptionsOverride,
  };
  return new Redis(opts.url, baseOptions);
}

export function createBullConnection(opts: BullConnectionOptions): BullConnections {
  const client = makeClient(opts, 'client');
  const subscriber = makeClient(opts, 'subscriber');
  const blocking = makeClient(opts, 'blocking');
  return {
    client,
    subscriber,
    blocking,
    async close(): Promise<void> {
      await Promise.allSettled([client.quit(), subscriber.quit(), blocking.quit()]);
    },
  };
}

export async function closeBullConnection(c: BullConnections): Promise<void> {
  await c.close();
}
