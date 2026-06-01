# `@apex/shared-events`

Domain event names, payload Zod schemas, and pure state-machine reducers.

Reference: [Phase 4 §4.2](../../docs/architecture/04-backend-design.md#42-run-state-machine).

Contents:
- Event topic strings and channel name builders (`events:run:{runId}`, `events:user:{userId}`).
- Payload schemas for run lifecycle, application lifecycle, AI decisions, security events.
- Reducer functions: `(state, event) => state | RejectedTransition` for run, stage, application.

Reducers are pure; the orchestrator wraps them in a PG transaction with `SELECT ... FOR UPDATE` and a transactional outbox.
