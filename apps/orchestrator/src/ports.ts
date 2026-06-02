// Orchestrator ports — the side-effect boundaries the RunCoordinator depends on.
// Concrete adapters (PG via @apex/db, BullMQ via @apex/queue, outbox/realtime)
// implement these; the coordinator stays pure and unit-testable.
//
// Reference: docs/architecture/04-backend-design.md §4.

import type { RunState } from '@apex/shared-events';
import type { RunMode, RunPlan, PlatformKey } from '@apex/automation-core';
import type { DiscoveryTask, ApplyTask, SessionRefreshTask } from '@apex/automation-core';

/** A persisted run row (subset the coordinator reads/writes). */
export interface RunRecord {
  runId: string;
  userId: string;
  tenantId: string;
  mode: RunMode;
  state: RunState;
  plan: RunPlan;
  /** Per-platform stage UUIDs (stable across restarts; assigned at run creation). */
  stageIds: Record<string, string>;
}

/** Durable run store. All writes happen inside a single SELECT...FOR UPDATE tx. */
export interface RunStore {
  /** Load a run for update (row-locked). Returns null if missing. */
  loadForUpdate(runId: string): Promise<RunRecord | null>;
  /** Persist run state + plan atomically (within the same tx as outbox writes). */
  save(record: RunRecord): Promise<void>;
  /** Create a new run record. */
  create(record: RunRecord): Promise<void>;
}

/** Enqueues automation tasks onto the platform queues. */
export interface TaskDispatcher {
  dispatchDiscovery(task: DiscoveryTask): Promise<void>;
  dispatchApply(task: ApplyTask): Promise<void>;
  dispatchSessionRefresh(task: SessionRefreshTask): Promise<void>;
}

/** Publishes run/application events to the transactional outbox (→ realtime). */
export interface EventPublisher {
  publishRunEvent(runId: string, tenantId: string, event: Record<string, unknown>): Promise<void>;
}

/** Idempotency guard so a re-delivered command is applied at most once. */
export interface IdempotencyGuard {
  /** Returns true the FIRST time a key is seen; false on replays. */
  firstSeen(key: string): Promise<boolean>;
}

/** Ownership lease so only the owner replica writes a given run (sharding). */
export interface OwnershipLease {
  /** True if this replica owns the run's user shard. */
  owns(userId: string): boolean;
}

export type { PlatformKey };
