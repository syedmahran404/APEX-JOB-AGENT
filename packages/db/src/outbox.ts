// Transactional outbox helpers. Writes to outbox_events MUST happen inside the
// same Prisma transaction as the domain mutation, so the outbox-relay can
// safely treat its rows as committed truth.
//
// Reference: docs/architecture/04-backend-design.md §6.

import type { Prisma } from '@prisma/client';
import { type TxClient } from './transactions.js';

export interface AppendOutboxInput {
  tenantId: string;
  aggregate: 'run' | 'application' | 'user' | 'security' | 'audit';
  aggregateId: string;
  topic: string;
  payload: Record<string, unknown>;
}

export async function appendOutbox(tx: TxClient, input: AppendOutboxInput): Promise<void> {
  await (tx as unknown as { outboxEvent: Prisma.OutboxEventDelegate }).outboxEvent.create({
    data: {
      tenantId: input.tenantId,
      aggregate: input.aggregate,
      aggregateId: input.aggregateId,
      topic: input.topic,
      payload: input.payload as Prisma.InputJsonValue,
    },
  });
}

/** Drain a batch of undelivered events for the relay worker. Returns the rows. */
export async function pendingOutboxBatch(
  tx: TxClient,
  limit: number,
): Promise<
  Array<{
    id: bigint;
    tenantId: string;
    aggregate: string;
    aggregateId: string;
    topic: string;
    payload: unknown;
    attempts: number;
    occurredAt: Date;
  }>
> {
  return (tx as unknown as { outboxEvent: Prisma.OutboxEventDelegate }).outboxEvent.findMany({
    where: { deliveredAt: null },
    orderBy: { id: 'asc' },
    take: limit,
  });
}

export async function markOutboxDelivered(tx: TxClient, ids: bigint[]): Promise<void> {
  if (ids.length === 0) return;
  await (tx as unknown as { outboxEvent: Prisma.OutboxEventDelegate }).outboxEvent.updateMany({
    where: { id: { in: ids } },
    data: { deliveredAt: new Date() },
  });
}

export async function markOutboxFailed(tx: TxClient, id: bigint, error: string): Promise<void> {
  await (tx as unknown as { outboxEvent: Prisma.OutboxEventDelegate }).outboxEvent.update({
    where: { id },
    data: { attempts: { increment: 1 }, lastError: error.slice(0, 2000) },
  });
}
