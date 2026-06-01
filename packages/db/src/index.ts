// @apex/db — Prisma + repositories + transactional outbox.
// Apps must NOT import @prisma/client directly; use repositories from this package.
// (Enforced by apex/no-direct-prisma-in-apps.)

export { getPrisma, disconnectPrisma } from './client.js';
export { runInTransaction, type TxClient, type RunInTransactionOptions } from './transactions.js';
export {
  appendOutbox,
  pendingOutboxBatch,
  markOutboxDelivered,
  markOutboxFailed,
  type AppendOutboxInput,
} from './outbox.js';
export { UserRepository, type CreateUserInput, type UpdateLoginStateInput } from './repositories/user.repository.js';
export { SessionRepository, type CreateSessionInput, type CreatedSession } from './repositories/session.repository.js';
export { AuditRepository, type AuditEntry } from './repositories/audit.repository.js';
export {
  IdempotencyRepository,
  type RememberInput,
  type RecallResult,
} from './repositories/idempotency.repository.js';

// Re-export Prisma types so apps don't import @prisma/client directly.
export type { User, UserSession, AuditLog, Permission, Role, Platform, Prisma, PrismaClient } from '@prisma/client';
