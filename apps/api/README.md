# `apps/api` — API Gateway / BFF

The single entry point for the `web` client. NestJS with the Fastify adapter.

Phase reference: [Phase 4 §3](../../docs/architecture/04-backend-design.md#3-the-api-gateway-appsapi).

Key conventions:
- REST under `/api/v1`. OpenAPI 3.1 generated from Zod via `@asteasolutions/zod-to-openapi`.
- Auth: `__Host-` session cookie, WebAuthn primary + TOTP, double-submit CSRF, step-up MFA on sensitive paths.
- Authorization: RBAC + permission scopes (`@RequirePermission(...)` decorator).
- Idempotency: `Idempotency-Key` header on mutations.
- Rate limiting: token bucket per principal + per IP via Redis.
- Errors: typed hierarchy from `packages/shared-errors`.
- Real-time fan-out via Socket.IO (`/socket.io/`).
- Internal-only routes under `/internal/*` reachable only via the service mesh.
