# `tools/eval-harness`

Runs AI eval suites against the prompt registry.

Reference: [Phase 7 §10](../../docs/architecture/07-ai-engine.md#10-the-eval-harness).

Behavior:
- Discovers eval YAMLs under `packages/ai-core/prompts/<key>/v<N>/evals/`.
- Executes each case against the configured provider (default `MOCK`; real providers when `--live` is passed).
- Asserts: Zod-parsable shape, `jq`-defined value assertions, banned/required regex, cost and latency budgets per case, stability across N runs.
- Writes results to `ai_eval_results` (when DB target is configured) and a JSON report locally.
- The `--budget=$X` flag refuses to run a `--live` suite that would exceed the dollar cap.

CI gate: a prompt change without a green eval cannot merge.
