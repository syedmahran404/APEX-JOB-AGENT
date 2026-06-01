# `apps/ai-service` — AI gateway, RAG, audit, cost

NestJS service that fronts every LLM call in the system. Workers and the orchestrator never address providers directly.

Phase reference: [Phase 7 — AI Engine](../../docs/architecture/07-ai-engine.md).

Modules:
- `gateway/` — `/score-jobs`, `/answer-question`, `/tailor-resume`, `/generate-cover-letter`, `/review-profile`, `/classify-captcha`, `/normalize-question`.
- `rag/` — embed, search (hybrid lex + semantic via `pgvector`), rerank.
- `prompts/` — loader bound to `packages/ai-core` registry; resolves the active version per environment.
- `governor/` — per-user daily ceilings, tier downgrades under pressure, skip-non-essential at 95% budget.
- `audit/` — writes `ai_decisions` with PII-redacted inputs.

Conventions:
- Every model call returns Zod-validated structured output. One retry with stricter prompt on validation failure; then fallback per ladder.
- Memory-first lookup for `app.answer` (`qa_memory.question_norm` exact match) keeps answers consistent across applications.
- Decision audit is mandatory; merging a prompt change without evals is blocked in CI.
