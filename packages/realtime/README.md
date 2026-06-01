# `@apex/realtime`

Socket.IO server primitives (used by `apps/api`) and client conventions (used by `apps/web`).

Reference: [Phase 5 §6](../../docs/architecture/05-frontend-design.md#6-real-time-ux).

Channels:
- `events:user:{userId}` — run lifecycle, application status, suggestions, security events.
- `events:run:{runId}` — joined transiently while the user is on a run-detail page.

Conventions:
- One Socket.IO connection per tab; reconnect with exponential backoff.
- A `since` cursor lets clients replay missed events via `GET /events?since=...` after reconnect.
- The frontend's `useRealtime(topic, handler)` hook handles join/leave consistently.
