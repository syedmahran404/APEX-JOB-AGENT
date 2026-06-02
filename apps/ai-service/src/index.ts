// @apex/ai-service — production AI gateway. Exports the composable pieces so
// other services (orchestrator, worker) and tests can embed the gateway directly.

export { AnthropicProvider, type AnthropicOptions } from './providers/anthropic.js';
export { OpenAIProvider, type OpenAIOptions } from './providers/openai.js';
export { VoyageProvider, type VoyageOptions } from './providers/voyage.js';
export { ProviderRouter, type ProviderMap, type RouterResult } from './providers/router.js';
export { httpJson, classifyHttpStatus, type HttpJsonOptions } from './providers/http.js';
export {
  AiGateway,
  type AiGatewayDeps,
  type DecisionSink,
  type RunPromptInput,
  type RunPromptResult,
} from './gateway/gateway.js';
export { PrismaDecisionSink, type PrismaDecisionSinkOptions } from './gateway/prisma-sink.js';
export { composeEngine, type ComposedEngine } from './composition.js';
export { AiServiceEnv } from './env.js';
