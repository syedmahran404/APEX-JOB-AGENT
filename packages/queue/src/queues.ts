// Queue name catalog. Source of truth for both producers (orchestrator) and
// consumers (workers, scheduler). Adding a queue requires touching this file
// so reviews are uniform.

export const QUEUES = {
  /** Discovery tasks per stage. */
  PlatformDiscovery: 'q:platform.discovery',
  /** Application tasks per eligible job. */
  PlatformApply: 'q:platform.apply',
  /** Session refresh tasks for stale Playwright contexts. */
  PlatformSessionRefresh: 'q:platform.session.refresh',
  /** Worker → orchestrator events stream. */
  PlatformEvents: 'q:platform.events',
  /** Non-blocking AI work (e.g., bulk relevance scoring). */
  AICall: 'q:ai-call',
  /** Outbound notification dispatch. */
  Notify: 'q:notify',
  /** Outbound webhook delivery (Phase 5). */
  WebhookDelivery: 'q:webhook.delivery',
  /** Bulk operation runner (Phase 5). */
  BulkOps: 'q:bulk-ops',
  /** Schedule firings (Phase 2 scheduler service). */
  ScheduleFire: 'q:schedule.fire',
  /** Embedding refresh (Phase 3). */
  EmbeddingRefresh: 'q:embedding.refresh',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/**
 * The conventional dead-letter queue name for any queue: `${name}.dlq`.
 * Workers move jobs that exhaust retries into the DLQ; an alert fires when
 * DLQ depth > 0 for more than 5 minutes.
 */
export function dlqName(q: QueueName): string {
  return `${q}.dlq`;
}

/**
 * Default retry policy. Individual queues can override by passing custom
 * options when adding a job.
 */
export const DEFAULT_RETRY_POLICY = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 10_000 },
  removeOnComplete: { age: 60 * 60 * 24 * 3, count: 5_000 }, // 3 days, last 5k
  removeOnFail: { age: 60 * 60 * 24 * 14, count: 5_000 }, // 14 days
} as const;
