// Composition root — assembles the AI engine from env config:
//   - provider map (mock OR live anthropic/openai/voyage),
//   - model registry (MOCK_REGISTRY in mock mode, DEFAULT_REGISTRY in live),
//   - ProviderRouter, PrismaDecisionSink, AiGateway.
//
// This is where the abstract pieces become a concrete, runnable engine.

import {
  DEFAULT_REGISTRY,
  MOCK_REGISTRY,
  MockProvider,
  defaultPromptRegistry,
  type AiProvider,
  type ModelRegistry,
} from '@apex/ai-core';
import { AiRepository, getPrisma } from '@apex/db';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider } from './providers/openai.js';
import { VoyageProvider } from './providers/voyage.js';
import { ProviderRouter, type ProviderMap } from './providers/router.js';
import { AiGateway } from './gateway/gateway.js';
import { PrismaDecisionSink } from './gateway/prisma-sink.js';
import { PreconditionFailedError } from '@apex/shared-errors';
import type { AiServiceEnv } from './env.js';

export interface ComposedEngine {
  registry: ModelRegistry;
  router: ProviderRouter;
  gateway: AiGateway;
  mode: 'mock' | 'live';
}

/** Build the live provider map, asserting the required keys are present. */
function liveProviders(env: AiServiceEnv): ProviderMap {
  const timeoutMs = env.AI_REQUEST_TIMEOUT_MS;
  const map: ProviderMap = {};

  if (!env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY) {
    throw new PreconditionFailedError(
      'AI_PROVIDER_MODE=live requires at least one of ANTHROPIC_API_KEY or OPENAI_API_KEY',
    );
  }
  if (env.ANTHROPIC_API_KEY) {
    map.anthropic = new AnthropicProvider({
      apiKey: env.ANTHROPIC_API_KEY,
      ...(env.ANTHROPIC_BASE_URL ? { baseUrl: env.ANTHROPIC_BASE_URL } : {}),
      timeoutMs,
    });
  }
  if (env.OPENAI_API_KEY) {
    map.openai = new OpenAIProvider({
      apiKey: env.OPENAI_API_KEY,
      ...(env.OPENAI_BASE_URL ? { baseUrl: env.OPENAI_BASE_URL } : {}),
      timeoutMs,
    });
  }
  if (env.VOYAGE_API_KEY) {
    map.voyage = new VoyageProvider({ apiKey: env.VOYAGE_API_KEY, timeoutMs });
  } else if (map.openai) {
    // No Voyage key → route the embed tier to OpenAI (DEFAULT_REGISTRY backup).
    map.voyage = map.openai;
  }
  return map;
}

/** Build the mock provider map (every tier resolves to the same MockProvider). */
function mockProviders(): ProviderMap {
  const mock = new MockProvider();
  return { mock };
}

export function composeEngine(env: AiServiceEnv): ComposedEngine {
  const isLive = env.AI_PROVIDER_MODE === 'live';
  const registry = isLive ? DEFAULT_REGISTRY : MOCK_REGISTRY;
  const providers: ProviderMap = isLive ? liveProviders(env) : mockProviders();
  const router = new ProviderRouter(registry, providers);

  const repo = new AiRepository(getPrisma({ databaseUrl: env.DATABASE_URL }));
  const sink = new PrismaDecisionSink({
    repo,
    tenantId: env.TENANT_ID,
    defaultCeilingUsd: env.AI_DAILY_CEILING_USD,
  });

  const gateway = new AiGateway({ registry, prompts: defaultPromptRegistry, router, sink });
  return { registry, router, gateway, mode: isLive ? 'live' : 'mock' };
}

/** Re-export the providers (live AiProvider instances) for advanced wiring/tests. */
export type { AiProvider };
