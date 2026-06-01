# `@apex/platform-adapters`

One subpackage per platform. Each implements the `PlatformAdapter` interface from `@apex/automation-core`.

Reference: [Phase 2 §5](../../docs/architecture/02-folder-structure.md#5-the-packagesplatform-adapters-shape) and [Phase 6 §3–§4](../../docs/architecture/06-automation-engine.md#3-the-adapter-contract).

Subpackages:

| Adapter | First milestone | Notes |
| --- | --- | --- |
| [`linkedin/`](./linkedin) | M2 | First adapter; reference implementation |
| [`naukri/`](./naukri) | M5 | Multi-step apply heavy |
| [`indeed/`](./indeed) | M5 | Locale-branched flows |
| [`internshala/`](./internshala) | M8 | Common with student profiles |
| [`glassdoor/`](./glassdoor) | M8 | Frequent ATS handoffs |
| [`foundit/`](./foundit) | M8 | Stable layouts |
| [`wellfound/`](./wellfound) | M8 | Heavy JS app |
| [`upwork/`](./upwork) | M8 | "Apply" = send proposal |

Per-adapter shape:

```
src/
├── adapter.ts            # Implements PlatformAdapter
├── selectors.ts          # All DOM selectors, layered (test-id → role+name → text → nth-child)
├── flows/                # login, search, parse-listing, parse-job, apply, answer-questions
├── fixtures/             # Saved HTML for offline tests
└── version.ts            # Exported semver; bumped on selector change
test/                     # Unit + offline integration
```

Rules:
- No selector path without a fallback (lint enforced).
- Offline tests must pass before any change to `selectors.ts`.
- Nightly canary against the real site (read-only) tracks drift; failures alert.
