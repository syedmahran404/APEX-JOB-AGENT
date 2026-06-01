# `apps/orchestrator` — Run state machine

The single writer of `job_runs.status`, `run_stages.status`, and `applications.status`. Sharded across replicas by consistent-hash on `user_id` with Redis-leased ownership.

Phase reference: [Phase 4 §4](../../docs/architecture/04-backend-design.md#4-the-orchestrator-appsorchestrator).

Key conventions:
- State transitions are pure reducers; the orchestrator wraps them in a `SELECT ... FOR UPDATE` transaction with a transactional outbox.
- Dispatcher loop: event-driven via BullMQ completion events, with a 30 s safety timer.
- Freshness ranking: t5h → t12h → t24h → t5d, discarding > 5 d.
- Pause / resume / stop semantics: in-flight tasks always complete; the run halts at the next clean boundary.
- Per-user, per-platform sequencing enforced; AI cost governor consulted before AI-dependent decisions.
