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

// Phase 1 repositories.
export { UserRepository, type CreateUserInput, type UpdateLoginStateInput } from './repositories/user.repository.js';
export { SessionRepository, type CreateSessionInput, type CreatedSession } from './repositories/session.repository.js';
export { AuditRepository, type AuditEntry } from './repositories/audit.repository.js';
export { IdempotencyRepository, type RememberInput, type RecallResult } from './repositories/idempotency.repository.js';

// Phase 2 — automation engine repositories.
export { JobRepository, type UpsertJobInput } from './repositories/job.repository.js';
export { JobCanonicalKeyRepository } from './repositories/canonical-key.repository.js';
export { RunRepository, type CreateRunInput, type FencedUpdateInput } from './repositories/run.repository.js';
export { StageRepository, type SeedStageInput } from './repositories/stage.repository.js';
export {
  ApplicationRepository,
  buildRunIdempotencyKey,
  buildManualIdempotencyKey,
  type CreateApplicationInput,
  type UpdateStatusInput,
} from './repositories/application.repository.js';
export {
  PlatformAccountRepository,
  PlatformCredentialRepository,
  PlatformSessionRepository,
  PlatformPermissionRepository,
  type CreateOrUpdateCredentialInput,
} from './repositories/platform-account.repository.js';
export {
  RunEventRepository,
  ApplicationEventRepository,
  type AppendRunEventInput,
  type AppendApplicationEventInput,
} from './repositories/event.repository.js';
export { ScreenshotRepository, type CreateScreenshotInput } from './repositories/screenshot.repository.js';

// Re-export Prisma types so apps don't import @prisma/client directly.
export type {
  User,
  UserSession,
  AuditLog,
  Permission,
  Role,
  Platform,
  Job,
  JobRun,
  RunStage,
  Application,
  ApplicationQuestion,
  ApplicationFile,
  ApplicationEvent,
  RunEvent,
  PlatformAccount,
  PlatformCredential,
  PlatformSession,
  PlatformPermission,
  Screenshot,
  JobCanonicalKey,
  Prisma,
  PrismaClient,
  // enums
  RunMode,
  RunStatus,
  StageStatus,
  ApplicationStatus,
  PlatformAccountStatus,
  SessionHealth,
  AutonomousMode,
  RemoteKind,
  FreshnessTier,
} from '@prisma/client';
