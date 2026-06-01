// Env schema for apps/api.

import { z } from 'zod';
import { CommonEnv, SecretOrVaultRef } from './common.js';

export const ApiEnv = CommonEnv.extend({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  DATABASE_URL: SecretOrVaultRef,
  REDIS_URL: SecretOrVaultRef,

  SESSION_COOKIE_DOMAIN: z.string().default('localhost'),
  SESSION_COOKIE_NAME: z.string().default('__Host-apex_sid'),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(60).default(60 * 60 * 8), // 8h
  SESSION_ABSOLUTE_TTL_SECONDS: z.coerce.number().int().min(60).default(60 * 60 * 24 * 14), // 14d
  CSRF_HMAC_SECRET: SecretOrVaultRef,

  WEBAUTHN_RP_ID: z.string().default('localhost'),
  WEBAUTHN_RP_NAME: z.string().default('Apex Job Agent'),
  WEBAUTHN_ORIGIN: z.string().url().default('http://localhost:5173'),

  CORS_ORIGIN: z.string().url().default('http://localhost:5173'),

  VAULT_ADDR: z.string().url(),
  VAULT_TOKEN: SecretOrVaultRef,
  VAULT_KV_MOUNT: z.string().default('secret'),

  RATE_LIMIT_DEFAULT_PER_MIN: z.coerce.number().int().min(1).default(120),
  RATE_LIMIT_AUTH_PER_5MIN: z.coerce.number().int().min(1).default(5),

  IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().min(60).default(60 * 60 * 24), // 24h hot in Redis
  IDEMPOTENCY_BACKSTOP_DAYS: z.coerce.number().int().min(1).default(7),
});
export type ApiEnv = z.infer<typeof ApiEnv>;
