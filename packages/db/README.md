# `@apex/db`

Prisma schema, migrations, seed, repositories, transactional outbox helpers.

Reference: [Phase 3 — Database Design](../../docs/architecture/03-database-design.md).

Layout:

```
prisma/
├── schema.prisma             # Single source of truth
├── migrations/               # Generated; checked in; forward-only
└── seed.ts                   # Idempotent dev seed (static reference data only)

src/
├── client.ts                 # PrismaClient singleton + tracing
├── repositories/             # Hand-written, Prisma-backed; tenant-scoped queries
├── transactions.ts           # runInTransaction with retry on serialization conflicts
├── outbox.ts                 # Transactional outbox helpers
└── extensions/               # pgvector helpers, audit hooks
```

Rules:
- Apps **never** use `PrismaClient` directly — only through repositories. Enforced by `apex/no-direct-prisma-in-apps`.
- Every repository method that reads or writes user-owned tables takes `userId` and applies `WHERE user_id = ?` (RLS lands in M9).
- Migrations are forward-only; breaking changes are split into add → backfill → cutover → drop across releases.
- Extensions (`pgvector`, `pg_partman`, `pg_trgm`, `citext`, `pgcrypto`) live in raw SQL appended to migration files with `-- raw:` comments.
