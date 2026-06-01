# `@apex/shared-types`

The single source of truth for data shapes that cross processes (HTTP, queues, AI calls, real-time events).

Rule: **Zod only, no classes, no interfaces.** TypeScript types are derived via `z.infer`. Frontend and backend import the same schemas; drift is impossible.

Layout (see [Phase 2 §7](../../docs/architecture/02-folder-structure.md#7-the-packagesshared-types-layout)):

```
src/
├── api/            # Request + response schemas, per route
├── domain/         # User, Profile, Resume, Job, Application, ...
├── events/         # Re-exports from shared-events (typed names)
├── ai/             # Prompt I/O Zod schemas (one per prompt id + version)
└── index.ts
```

This package is a leaf: it imports nothing from other internal packages. Enforced by `apex/zod-only-in-shared-types`.
