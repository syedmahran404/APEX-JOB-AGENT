# `@apex/queue`

BullMQ wrappers, queue name catalog, dead-letter helpers.

Reference: [Phase 4 §5.2](../../docs/architecture/04-backend-design.md#52-orchestrator--workers-via-bullmq-not-http).

Queues:
- `q:platform.discovery` — discovery tasks per stage.
- `q:platform.apply` — application tasks per eligible job.
- `q:platform.session.refresh` — session refresh tasks.
- `q:platform.events` — worker → orchestrator result stream.
- `q:ai-call` — non-blocking AI work (e.g., bulk relevance scoring).
- `q:notify` — notification dispatch.

Every queue has a paired `*.dlq` and a documented retry policy. Workers must ack only after the unit of work is durably committed to PG (transactional outbox pattern).
