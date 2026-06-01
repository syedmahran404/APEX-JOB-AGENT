# APEX JOB AGENT

An AI-powered, autonomous, multi-platform job application platform.

> Status: Architecture phase. No runtime code yet. The complete production design lives in [`docs/architecture/`](./docs/architecture/).

APEX JOB AGENT operates like a highly-skilled human job seeker that runs 24/7. It learns the user's professional identity once, then continuously discovers fresh listings, scores them, fills applications across eight major platforms, answers free-form questions in the user's voice, and reports outcomes through an enterprise-grade analytics surface.

## Supported Platforms

LinkedIn · Naukri · Indeed · Internshala · Glassdoor · Foundit · Wellfound · Upwork

## Core Pillars

| Pillar | What it means in practice |
| --- | --- |
| Freshness-first | Apply to jobs <5h old before <12h, before <24h, before <5d. Discard >5d. |
| Autonomous but accountable | Two modes: human-assisted (pause on OTP/CAPTCHA) and fully autonomous (skip + log). |
| Permission-gated mutation | No profile or resume edit without explicit, scoped user approval. |
| Resumable by design | Multi-platform runs survive crashes, restarts, and long pauses. |
| Auditable AI | Every model decision is logged with prompt, response, cost, and reasoning. |
| Vault-backed security | Envelope encryption, per-user data keys, no plaintext credentials anywhere. |

## Architecture Documents

Read in order:

1. [System Architecture](./docs/architecture/01-system-architecture.md)
2. [Folder Structure](./docs/architecture/02-folder-structure.md)
3. [Database Design](./docs/architecture/03-database-design.md)
4. [Backend Design](./docs/architecture/04-backend-design.md)
5. [Frontend Design](./docs/architecture/05-frontend-design.md)
6. [Automation Engine](./docs/architecture/06-automation-engine.md)
7. [AI Engine](./docs/architecture/07-ai-engine.md)
8. [Security Architecture](./docs/architecture/08-security-architecture.md)
9. [Deployment Architecture](./docs/architecture/09-deployment-architecture.md)
10. [Implementation Roadmap](./docs/architecture/10-implementation-roadmap.md)

Cross-cutting reference:

- [Architecture overview & decision log](./docs/architecture/00-overview.md)
- **[Architecture Audit & Refinements](./docs/audit/00-overview.md)** — post-design audit; supersedes the architecture wherever they conflict. Read before starting implementation.

## License & Use

Single-tenant by default. Multi-tenant deployment is a roadmap item (M9). Not affiliated with any of the listed job platforms; respects their terms by operating only within the authenticated user's session and at human-equivalent rates.
