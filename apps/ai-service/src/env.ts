// ai-service environment schema. Provider keys are optional so the service can
// boot in MOCK mode (AI_PROVIDER_MODE=mock) for local dev / tests without keys;
// in 'live' mode the relevant keys are required (validated at composition time).

import { z } from 'zod';
import { Env } from '@apex/shared-types';

export const AiServiceEnv = Env.CommonEnv.extend({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3002),
  DATABASE_URL: z.string().min(1),

  /** 'mock' uses the in-memory MockProvider; 'live' uses real providers. */
  AI_PROVIDER_MODE: z.enum(['mock', 'live']).default('mock'),
  ANTHROPIC_API_KEY: Env.SecretOrVaultRef.optional(),
  OPENAI_API_KEY: Env.SecretOrVaultRef.optional(),
  VOYAGE_API_KEY: Env.SecretOrVaultRef.optional(),
  ANTHROPIC_BASE_URL: z.string().url().optional(),
  OPENAI_BASE_URL: z.string().url().optional(),

  /** Default per-user daily AI cost ceiling (USD). */
  AI_DAILY_CEILING_USD: z.coerce.number().positive().default(5),
  /** Per-request provider timeout (ms). */
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  /** Tenant id this service instance serves (single-tenant until Phase 8). */
  TENANT_ID: z.string().uuid().default('00000000-0000-0000-0000-000000000000'),
});

export type AiServiceEnv = z.infer<typeof AiServiceEnv>;
