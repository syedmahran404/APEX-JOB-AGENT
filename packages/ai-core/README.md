# `@apex/ai-core`

Immutable assets for the AI engine: prompt registry, provider abstraction, eval primitives, calibration utilities, style rules.

Reference: [Phase 7 — AI Engine](../../docs/architecture/07-ai-engine.md).

Layout:

```
src/
├── providers/                # AnthropicProvider, OpenAIProvider, MockProvider
├── prompts/                  # Versioned prompt assets (see below)
├── style/                    # Banned phrases, peer norms, tone guides
├── calibration/              # Score → outcome calibration
└── governor/                 # Cost ceiling primitives (the runtime governor lives in apps/ai-service)

prompts/
├── job.relevance.score/v1/
├── app.answer/v1/
├── resume.tailor/v1/
├── cover.letter/v1/
├── profile.review/v1/
├── captcha.classify/v1/
└── qa.normalize/v1/
```

Each prompt folder contains: `prompt.md`, `output.schema.ts` (Zod), `examples/`, `evals/`, `changelog.md`, `index.ts`.

Rule: **never edit a prompt in place.** New behavior = new version directory.
