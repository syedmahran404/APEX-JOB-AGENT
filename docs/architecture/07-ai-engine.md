# Phase 7 — AI Engine

## 1. Goals

The AI engine is the system's judgment layer. It must produce decisions that are:

- **Useful**: high-signal job scores, accurate question answers, well-targeted resume edits, on-brand cover letters, actionable profile suggestions.
- **Consistent**: the same user gets the same answer to the same question across applications and across days.
- **Auditable**: every consequential decision has its full lineage stored — prompt id and version, model, input, output, reasoning summary, token cost, time, trace id.
- **Bounded**: a misbehaving prompt can never overrun cost, never write user data without intent, never silently mutate facts about the user.
- **Replaceable**: the upstream model lineup will keep changing. Switching providers or models must be a configuration change, not a refactor.

This phase covers: the gateway and provider abstraction, the prompt registry, the RAG pipeline over the user's knowledge base, the decision audit, the cost governor, the eval harness, the five core prompts, and the safety rules.

## 2. The five core prompts

Every other AI capability is one of these or a composition of them.

| Key | Purpose | Tier (default) | Cardinality |
| --- | --- | --- | --- |
| `job.relevance.score` | Score a batch of jobs 0–100 against the user's profile, return top-line reasoning per job | `default` | per job (batched 8–16) |
| `app.answer` | Produce a consistent answer to one application question, drawing from the user's knowledge base and prior answers | `default` | per question |
| `resume.tailor` | Propose a tailored resume version for a given job (returns a structured edit set, never freeform replace) | `reason` | per (resume, job) |
| `cover.letter` | Draft a cover letter for a specific job in the user's voice | `default` | per application |
| `profile.review` | Audit the user's profile, return scored, actionable suggestions | `reason` | per user, on demand |

Two supporting prompts:
- `captcha.classify` — `fast` tier; called rarely, only when DOM/URL heuristics are ambiguous.
- `qa.normalize` — `fast` tier; canonicalizes a raw question into the form used as a `qa_memory.question_norm` lookup key.

## 3. Tiered model routing

We treat models as a portfolio. Three tiers, each abstract, each mapped to a concrete model in the registry.

| Tier | Role | Concrete (default) | Backup | Notes |
| --- | --- | --- | --- | --- |
| `reason` | Hard, low-volume, high-stakes reasoning | Anthropic `claude-opus-4` | OpenAI `o-class` reasoning | Resume tailoring, profile review, ambiguous Q&A |
| `default` | Bulk well-shaped work | Anthropic `claude-sonnet-4` | OpenAI `gpt-4.1` | Job scoring, common Q&A, cover letters |
| `fast` | Routine classification, normalization | Anthropic `claude-haiku-4` | OpenAI `gpt-4o-mini` | CAPTCHA classify, question normalize, freshness boost classify |
| `embed` | Embeddings for RAG | `voyage-2-large` | `text-embedding-3-large` | 1024-dim; we keep a single model per cohort to avoid mixing distances |

Routing rules:
- The default tier per prompt is in `ai_prompts` and is overridable per call (e.g., the orchestrator promotes `app.answer` to `reason` when prior `qa_memory` confidence is low).
- A prompt can declare a **fallback ladder** (e.g., `default → reason` after one Zod-validation failure).
- The cost governor (§7) can downgrade tier under budget pressure.

The provider abstraction (`packages/ai-core/providers/`) exposes one interface: `complete({ model, system, messages, tools?, schema? }) → { output, usage }`. Provider-specific quirks (tool-use formats, system-prompt placement, JSON-mode flags) are normalized inside the adapter. Adding a provider is one file plus registry registration.

## 4. The prompt registry

Prompts are versioned source code, not strings hidden in a service. They live in `packages/ai-core/prompts/<key>/v<N>/` with this shape:

```text
packages/ai-core/prompts/job.relevance.score/v3/
├── prompt.md            # The system + user template (Handlebars-style placeholders)
├── output.schema.ts     # Zod schema for the structured output
├── examples/            # Few-shot exemplars used in the prompt
├── evals/               # Eval datasets and expected behaviors (Phase §10)
├── changelog.md         # Why this version exists
└── index.ts             # Loader: validates template + schema + examples
```

At service boot, `ai-service` registers every prompt by `(key, version)` and records active versions to `ai_prompts` so each `ai_decisions` row joins to a real prompt object.

A prompt is never modified in place. New behavior = new version. The registry resolves the active version per environment via a feature-flag table (`ai_prompts.is_active`) so we can canary v4 to 5% of users while v3 remains the default.

Each prompt declares:
- `inputSchema` — what the caller must pass.
- `outputSchema` — what the model must return.
- `temperature`, `maxTokens`, `topP` — tuned per prompt.
- `responseFormat` — `'json'` (default), `'text'` only when truly free-form (cover letter body).
- `safety` — content rules (e.g., `"never invent employment history"`).

## 5. Structured output and validation

Every prompt that produces a decision returns JSON validated against a Zod schema before it is allowed to mutate state. Three reasons this is non-negotiable:

1. The DB column types depend on it. `applications.ai_score` is `SMALLINT`; an answer of `"about 80"` is a bug.
2. Downstream consumers (worker, frontend) carry the inferred TypeScript type and never have to defensively parse.
3. It catches *silent* model regressions. If the model starts returning an extra field or omitting one, validation fails loudly.

Behavior on validation failure:
- One retry with a stricter system message (`"Your previous output failed to parse: <issues>. Return JSON exactly matching the schema."`) and a slightly lower temperature.
- If retry fails: fall through to the prompt's declared fallback (e.g., upgrade tier; or for `app.answer`, return a `human-required` answer with reason `policy:low-confidence`).
- Both attempts are logged in `ai_decisions` with `output` containing the raw text and a `validation_error` field.

For the cover letter (free text), validation enforces structural constraints: paragraph count in [3, 5], total characters in [600, 2400], no first-person plural, no phrases from a banned list (clichés like "rockstar", "synergy", etc., maintained in `packages/ai-core/style/banned.ts`).

## 6. RAG over the user's knowledge base

The user's profile + prior answers + projects + experiences is the agent's memory. The AI engine retrieves from it for two prompts: `app.answer` and `resume.tailor`.

### 6.1 What gets embedded

- `frequent_answers.answer` (one row → one embedding).
- `qa_memory.answer` (one row → one embedding; question text is also embedded for question-side recall).
- `work_experiences.description + achievements` (one row → one or two embeddings depending on length).
- `projects.description` (one embedding).
- `user_skills` (skill-cluster embeddings; not individual tokens).
- The latest approved `resume_versions.parsed` (sectioned).

Each lands in `embeddings` with `(owner_kind, owner_id)` and a `text_hash` so we don't re-embed unchanged content.

### 6.2 The retrieval pipeline

For `app.answer`:

1. **Normalize** the question via `qa.normalize` (small model, deterministic) → `question_norm`.
2. **Lookup table** first: exact match on `qa_memory(user_id, question_norm)` → if found and `used_count >= 1`, return that answer (free, deterministic). This is what gives consistency across applications.
3. **Hybrid search** if no exact match:
   - Lexical: trigram similarity over `qa_memory.question_norm` and `frequent_answers.prompt` (top 8).
   - Semantic: pgvector cosine over question embeddings (top 8).
   - Merge with a learned weight (`0.4 * lex + 0.6 * sem` initially, tuned via eval).
   - Keep top-k=5.
4. **Profile pull**: small structured slice of `user_profiles`, `personal_info` (only the fields whose presence is allowed by the answer's category), and the chosen resume version's relevant section.
5. **Answer prompt** runs with: question, top-k memory candidates, profile slice, field constraints (kind, options, length).
6. **Persist**: a new `qa_memory` row if the AI generated a novel answer; bump `used_count` on the matched row; write `application_questions` and `ai_decisions`.

For `resume.tailor`:
- Retrieve top-k experiences and projects most similar to the job description.
- Retrieve job's required skills overlapping with `user_skills`.
- The prompt returns a structured edit set: a list of `{ section, bulletId?, op: 'reword'|'reorder'|'highlight'|'add_skill', proposedText? }` operations, never a freeform "new resume" string. The application of edits is mechanical and reversible.

### 6.3 Why pgvector and these knobs

- pgvector at our scale (millions of vectors total, sub-million per user) handles IVFFlat with `lists ≈ sqrt(N)` cleanly. ANN recall ≥ 0.95 in our eval set, latency p95 < 30 ms.
- We avoid HNSW for now because IVFFlat builds faster on insert-heavy workloads and our retrieval-time recall is sufficient.
- Hybrid lex+sem outperforms pure-vector by ~6 percentage points on top-1 accuracy for "what is your notice period" style questions where exact phrasing varies.

## 7. The cost governor

LLM cost is a real, recurring expense. Without a governor it grows quietly until it doesn't. The governor sits in front of every model call.

### 7.1 Mechanics

- **Per-user daily ceiling** (`ai_cost_ledger`): default $0.50/day; configurable per-user.
- **Per-tenant monthly ceiling** (when multi-tenant lands in M9).
- **Per-prompt budget weight**: `resume.tailor` weighs 8× `app.answer`; the governor enforces a tier-aware budget so a single user can't burn the day's budget on tailoring.
- **Burst control**: token bucket at 60 calls / minute per user, 600 / hour.
- **Provider-side rate limits**: respected via the provider adapter's response-headers parser; the governor backs off.

### 7.2 Decisions under pressure

When a user is at:
- < 80% of daily ceiling: normal.
- 80–95%: stop calling `resume.tailor` and `cover.letter`; downgrade `app.answer` to `default` tier (no `reason` upgrades); the dashboard shows a "budget pressure" indicator.
- ≥ 95%: pause new AI work for the user; the orchestrator continues running but skips AI-dependent decisions, recording `applications.skipped_low_score` only when scores are *known* below threshold (no new scoring).
- Recovery: ceilings reset at the user's local midnight.

The governor's decisions are observable: every choice is a structured event in `ai_decisions` with `governor_action: 'pass' | 'downgrade' | 'skip'`, so the user (and we) can see why a feature didn't fire.

## 8. The decision audit

Every model call (AI engine, including small classifications) writes one `ai_decisions` row. The row's `inputs` field is *redacted before write*: a deny-list strips known PII keys; an allow-list keeps the structural fields that make the decision reconstructible (e.g., for `app.answer`, the inputs include the question text and the candidate IDs of the memory rows used, not the answer texts themselves; the chosen answer is in `output`).

This gives us:
- A complete trail per application (`SELECT * FROM ai_decisions WHERE scope_id = app.id`).
- Cost attribution (`SELECT user_id, sum(cost_usd) FROM ai_decisions GROUP BY 1`).
- Eval replay: we can re-run a past decision against a new prompt version and compare.
- Subpoena-ready evidence in worst-case disputes ("the system answered X because the user had previously answered Y to the same question on date Z").

## 9. Determinism and consistency

Three mechanisms together produce consistency without making the agent feel robotic:

1. **Memory-first retrieval.** Same question → same answer almost always, because the lookup table hits before the model.
2. **Locked frequent answers.** `frequent_answers.is_locked = true` answers are never rewritten. The user controls them.
3. **Low temperature for facts, moderate for prose.** `app.answer` runs at `temperature=0.2`; `cover.letter` at `0.5`; classification at `0.0`.

We *do not* seed for hard determinism; providers' seed support is unreliable. Logical determinism (memory-first) covers the user-visible cases.

## 10. The eval harness

Prompts ship with evals or they don't ship. The harness lives in `tools/eval-harness/` and runs in CI on every change to `packages/ai-core/prompts/**`.

### 10.1 What an eval is

A YAML file per prompt under `packages/ai-core/prompts/<key>/v<N>/evals/`:

```yaml
suite: app.answer-canonical
description: Common application questions, expected canonical shape
cases:
  - id: notice-period-numeric
    input:
      questionRaw: "What is your notice period (in days)?"
      fieldKind: number
      profile: { noticePeriodDays: 30 }
    expect:
      shape: { answer: { type: number } }
      assertions:
        - jq: '.answer == 30'
        - max_tokens: 80
  - id: relocation-yes
    input:
      questionRaw: "Are you willing to relocate?"
      fieldKind: select
      options: ["Yes","No","Maybe"]
      profile: { willingToRelocate: true }
    expect:
      assertions:
        - jq: '.answer == "Yes"'
```

### 10.2 What it asserts

- Shape (Zod parses the output).
- Field values via `jq` expressions.
- Cost and latency budgets per case.
- Banned phrases / required phrases via regex.
- Stability across N runs (e.g., 5 runs must all produce identical `answer`).

### 10.3 Pass criteria

- 100% pass on **canonical** suite to merge a prompt change.
- ≥ 95% pass on **regression** suite (real anonymized cases) and no regression > -2 percentage points vs the active version.
- Cost-per-call may not increase by more than 20% without an explicit ADR.

A change that fails evals cannot ship. The harness writes results to `ai_eval_results` so the team can browse trends.

## 11. Profile review prompt (the optimizer)

`profile.review` runs on demand from the optimization screen. It is the most ambitious prompt we operate, so it has extra rails.

Inputs:
- Full structured profile snapshot (no PII like phone/DoB).
- Anonymized peer-cohort norms (e.g., "average summary length for backend engineers with 3–5y in your locations: 95–140 words"). These norms are precomputed from the user base after consent (M9) — until then, we use static, hand-curated norms in `packages/ai-core/style/peer-norms.json`.
- The user's stated job intent (target titles, locations, currency).

Output: a list of suggestions, each:

```ts
{
  id: string;
  area: 'headline'|'summary'|'skills'|'experience'|'projects'|'links';
  issue: string;          // one sentence
  expectedBenefit: string;// one sentence, calibrated by area-specific impact estimates
  current: string;        // exact existing text or representation
  proposed: string;       // exact replacement
  confidence: number;     // 0..1
  references?: string[];  // ids into peer-norms or user data
}
```

Rails:
- The prompt is forbidden from inventing achievements, skills, or roles. The prompt explicitly states this; the eval suite verifies it (canonical case: profile with three jobs; output may not introduce a fourth).
- `confidence < 0.6` suggestions are filtered out before display.
- The user must approve each suggestion individually; nothing is bulk-applied.

## 12. Cover letter prompt

Tone is selectable: `professional`, `enthusiastic`, `concise`. Structure: opening hook tied to the company, two body paragraphs, closing CTA. Hard constraints:
- No fabricated alignment ("Your mission of X resonates with my own...") unless the user's profile actually contains evidence.
- No mention of compensation unless the job description does.
- No filler clichés (banned list).
- Always closes with the user's contact handle from `links` (single canonical link).

Cover letters are stored as `application_files.kind = 'cover_letter'` in object storage; the AI decision row carries the prompt I/O.

## 13. Resume tailor prompt

The output is a *patch*, never a wholesale replacement.

```ts
type ResumePatch = {
  basedOnVersionId: string;
  reasoning: string;            // one short paragraph
  ops: Array<
    | { op: 'reorder', section: string, ids: string[] }
    | { op: 'reword', sectionItemId: string, proposedText: string, rationale: string }
    | { op: 'highlight', sectionItemId: string }
    | { op: 'add_skill', skillName: string, evidenceItemIds: string[] }
    | { op: 'reorder_skills', proposed: string[] }
  >;
};
```

The application of a patch is mechanical: the backend reads the patch, applies ops to a *new* `resume_versions` row with `source = 'ai_tailored'` and `parent_id` pointing to the basis. The user reviews the diff in the Resume Studio and approves before it can be used by the worker.

Constraints encoded in the prompt and verified in eval:
- A `reword` cannot introduce metrics (numbers, percentages) absent from the basis.
- An `add_skill` must reference at least one `evidenceItemIds` from the user's experience or projects; otherwise it is dropped.
- The output is a patch under N ops; if more, the prompt returns the most impactful N (keeps the diff reviewable).

## 14. Job relevance scoring

Inputs (per call, batched):
- The user's compact profile vector (precomputed; refreshed when profile changes).
- N job objects with title, company, description, required skills, salary, location, remote kind.
- The user's preferences (locations, salary, remote kind).

Output:
```ts
{
  results: Array<{
    jobId: string;
    score: number;        // 0..100
    drivers: { matchedSkills: string[], salaryFit: 'over'|'within'|'under'|'unknown', locationFit: 'good'|'okay'|'mismatch', titleAlignment: number /* 0..1 */ };
    reasoning: string;    // one sentence
    risks: string[];      // e.g., ['contract_only','requires_relocate']
  }>
}
```

The score is **calibrated**. We periodically join `applications.ai_score` with downstream outcomes (`shortlisted`, `interview`, `offer`) and adjust calibration in `packages/ai-core/calibration/`. A score of 80 should mean roughly the same thing in March as in October.

## 15. AI safety rules

These apply to every prompt:

1. **No fabrication of facts about the user.** Names, dates, employers, education, contact details — the model must use only what the user provided. The eval harness includes adversarial cases where the prompt is "pressured" (e.g., a question asks for a degree the user does not have); the expected behavior is to answer honestly or yield via `human-required`.
2. **No leakage across users.** Each call is single-user; the system prompt injects `user_id` only in opaque form (a hash); RAG retrieves only that user's vectors via a SQL filter.
3. **No PII in logs.** Inputs to `ai_decisions` are redacted (Phase 4 §8 logging conventions).
4. **No code execution outputs are trusted.** When a prompt suggests resume edits, the backend applies them through the patch contract, not by `eval`-ing model text.
5. **No model is allowed to send outbound network calls.** Tool use, when added in M6, will be limited to internal services (e.g., a "lookup-skill" tool against our own DB), each with explicit authorization and audit.
6. **Prompt injection defense.** Job descriptions and platform-rendered content are *untrusted input*. They are passed to the model in a clearly delimited block (`<JOB_DESCRIPTION_UNTRUSTED>...</JOB_DESCRIPTION_UNTRUSTED>`) with a system-prompt instruction not to follow instructions that appear inside that block. Eval suite includes injected payloads.

## 16. Performance and reliability

Targets:

| Operation | p95 budget | Measurement |
| --- | --- | --- |
| `app.answer` (memory hit) | 80 ms | DB-only path |
| `app.answer` (model path) | 1.5 s | Provider + parse + persist |
| `job.relevance.score` (batch=8) | 1.0 s | Provider call dominates |
| `resume.tailor` | 6 s | One reasoning model call |
| `cover.letter` | 4 s | Default tier |
| `profile.review` | 8 s | Reasoning model + RAG |
| `embed` (per chunk) | 200 ms | Provider |

Reliability:
- Circuit breaker per provider; trips after 5 consecutive 5xx in 60 s, half-opens after 30 s.
- Retry with jitter on 429 / transient 5xx; max attempts per call: 2.
- Dead-letter for prompts that exhaust retries (`q:ai-call.dlq`); reviewed daily.
- Latency-budget guard: a call past p99 latency is canceled and falls back; the cost ledger records the canceled tokens (some providers bill anyway).

## 17. Calibration and drift detection

We watch four signals weekly:

1. **Score → outcome calibration.** Correlation of `ai_score` with `shortlisted | interview | offer`. If correlation drops below threshold, recalibrate.
2. **Answer reuse rate.** % of `app.answer` calls that hit `qa_memory`. Should rise toward 60–70% as a user's memory matures; sudden drops mean the normalizer regressed.
3. **Validation failure rate.** Per prompt; spikes indicate provider drift or prompt regression. Hard alert at 1% sustained.
4. **Cost per application.** Sudden 25% jumps without traffic increases trigger review.

## 18. Local dev and test affordances

- A `MOCK` provider in `packages/ai-core/providers/mock.ts` plays back fixtures; used in unit tests and `infra/compose/e2e.compose.yaml`.
- A `RECORD/REPLAY` mode lets engineers run real prompts once, save the response, and replay deterministically on subsequent runs. Recordings land in `tools/eval-harness/recordings/` and are gitignored unless explicitly committed for an eval case.
- The eval harness has a `--budget=$X` flag that refuses to run if the suite would exceed the dollar cap.

## 19. Tradeoffs accepted

- **Two AI tiers from day one.** Adds routing complexity; saves 5–10× on routine traffic. Worth it.
- **pgvector over a dedicated vector store.** One fewer system to operate. We accept IVFFlat's recall tradeoff; eval shows it's enough for our scale.
- **Memory-first answers.** Slight latency saved; significant consistency gained. Some users may want fresh AI generations every time; we expose a per-question "Re-ask AI" option in the UI but it's not the default.
- **Patch-only resume edits.** More design work upfront; review-friendly diffs forever after. We never let the model rewrite a resume from scratch.
- **No tool use in M0–M5.** Tool-use is powerful and dangerous. We add it in M6 with strict whitelisting because the surface is too easy to abuse.
- **Self-hosted prompt registry instead of an LLM-ops SaaS.** Tighter integration with our DB, audit, and CI. Less polish than LangSmith or PromptLayer; fits our shape better.

## 20. What this phase deliberately does not decide

- The exact model names per tier in production — they will rotate; the registry holds them.
- The peer-cohort norms used in `profile.review` — bootstrap with curated values; learn from telemetry once the user base supports it (M9).
- The exact calibration math — we ship a simple isotonic regressor; refine when there's data.
- Tool definitions — designed when M6 adds tool use.
