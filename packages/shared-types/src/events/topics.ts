// Channel name builders for Redis Pub/Sub + Socket.IO rooms.
// The string format is part of the protocol; do not change without migration.

import { z } from 'zod';

const Uuid = z.string().uuid();

export function userTopic(userId: string): `events:user:${string}` {
  Uuid.parse(userId);
  return `events:user:${userId}`;
}

export function runTopic(runId: string): `events:run:${string}` {
  Uuid.parse(runId);
  return `events:run:${runId}`;
}

export function tenantTopic(tenantId: string): `events:tenant:${string}` {
  Uuid.parse(tenantId);
  return `events:tenant:${tenantId}`;
}

/** Validate a topic and tell the consumer which kind it is. */
export function parseTopic(topic: string):
  | { kind: 'user'; userId: string }
  | { kind: 'run'; runId: string }
  | { kind: 'tenant'; tenantId: string }
  | null {
  const parts = topic.split(':');
  if (parts.length !== 3 || parts[0] !== 'events') return null;
  const id = parts[2]!;
  if (!Uuid.safeParse(id).success) return null;
  switch (parts[1]) {
    case 'user':
      return { kind: 'user', userId: id };
    case 'run':
      return { kind: 'run', runId: id };
    case 'tenant':
      return { kind: 'tenant', tenantId: id };
    default:
      return null;
  }
}
