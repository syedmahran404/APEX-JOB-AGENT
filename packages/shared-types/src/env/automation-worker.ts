// Env schema for apps/automation-worker.

import { z } from 'zod';
import { CommonEnv, SecretOrVaultRef } from './common.js';

export const AutomationWorkerEnv = CommonEnv.extend({
  WORKER_ID: z.string().default(`worker-${Math.random().toString(36).slice(2, 8)}`),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3100),

  DATABASE_URL: SecretOrVaultRef,
  REDIS_URL: SecretOrVaultRef,

  VAULT_ADDR: z.string().url(),
  VAULT_TOKEN: SecretOrVaultRef,

  // Browser pool sizing.
  WORKER_MAX_CONCURRENT_CONTEXTS: z.coerce.number().int().min(1).max(64).default(4),
  WORKER_BROWSER_FAMILY: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
  WORKER_HEADLESS: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true')
    .default('true'),
  WORKER_BROWSER_REFRESH_INTERVAL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  WORKER_CONTEXT_TTL_MIN: z.coerce.number().int().min(1).max(120).default(10),
  WORKER_CONTEXT_RSS_BUDGET_MB: z.coerce.number().int().min(256).max(8192).default(1536),

  // Object storage for storage-state + screenshots.
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET_STORAGE_STATE: z.string().default('apex-storage-state'),
  S3_BUCKET_SCREENSHOTS: z.string().default('apex-screenshots'),
  S3_ACCESS_KEY_ID: SecretOrVaultRef,
  S3_SECRET_ACCESS_KEY: SecretOrVaultRef,
  S3_FORCE_PATH_STYLE: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true')
    .default('true'),

  // Anti-detection profile.
  ANTI_DETECTION_PROFILE: z.enum(['STRICT_DEFAULT', 'BALANCED', 'FAST']).default('STRICT_DEFAULT'),

  // Per-platform global rate limit (actions/min). Overridable per platform.
  RATE_GLOBAL_PER_PLATFORM_RPM: z.coerce.number().int().min(1).max(600).default(30),

  // Run task queue concurrency.
  RUN_TASK_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),

  // Capture / redaction.
  SCREENSHOTS_ENABLED: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true')
    .default('true'),

  // Feature flags / kill switches.
  KILL_SWITCH_ENABLED: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true')
    .default('false'),
});
export type AutomationWorkerEnv = z.infer<typeof AutomationWorkerEnv>;
