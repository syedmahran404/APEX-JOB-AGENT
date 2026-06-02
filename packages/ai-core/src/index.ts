// @apex/ai-core — the AI engine's pure, provider-agnostic core: prompt registry,
// provider abstraction (incl. MockProvider), structured-output validation +
// fallback ladder, RAG retrieval/merge, cost governor, decision audit, safety
// rails, and score calibration. The live providers + RAG DB queries + NestJS
// gateway live in apps/ai-service and consume these contracts.
//
// Reference: docs/architecture/07-ai-engine.md.

// Providers + registry.
export * from './providers/types.js';
export { MockProvider, fakeEmbed, type MockCompletionRule, type MockProviderOptions } from './providers/mock.js';
export * from './registry/models.js';

// Prompts.
export * from './prompts/schemas.js';
export * from './prompts/registry.js';

// Validation + fallback.
export * from './validation.js';

// RAG.
export * from './rag/vector.js';
export * from './rag/qa-memory.js';
export * from './rag/resume-prefilter.js';

// Governor.
export * from './governor/cost.js';

// Audit.
export * from './audit/decision.js';

// Safety + style.
export * from './safety/injection.js';
export * from './safety/guards.js';
export * from './style/banned.js';

// Calibration.
export * from './calibration/isotonic.js';
