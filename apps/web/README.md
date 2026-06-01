# `apps/web` — React SPA

The user's command center. React 18 + Vite + TypeScript strict + Tailwind + Radix-headless beneath custom UI + Framer Motion + R3F (sparingly).

Phase reference: [Phase 5 — Frontend Design](../../docs/architecture/05-frontend-design.md).

Key conventions:
- File-based routes under `src/app/`.
- Server state via TanStack Query; UI state via Zustand.
- Real-time via Socket.IO patches into TanStack Query caches.
- WCAG 2.2 AA enforced in CI via `@axe-core/playwright`.
- Performance budgets enforced by Lighthouse CI: LCP ≤ 1.8 s, INP ≤ 100 ms p95, main bundle ≤ 180 KB gzipped.
- R3F is used only in: Command Center hero, run-running badge, onboarding success moment.
