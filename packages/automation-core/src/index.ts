// @apex/automation-core — shared engine + base classes + manager primitives.
//
// Consumed by:
//   - packages/platform-adapters/<x>: implement PlatformAdapter via BasePlatformAdapter
//   - apps/automation-worker: drive runs via BaseAutomationEngine

export * from './types/index.js';
export * from './engine/index.js';
export * from './selectors/helpers.js';
export * from './utils/delay.js';
export { newUlid } from './utils/ulid.js';
export { redactValue, isSensitiveField } from './utils/redaction.js';
export type * from './managers/interfaces.js';
export * from './managers/index.js';
export * from './anti-detection/index.js';
export { detectAtsByUrl, detectAtsOnPage, type AtsKind } from './ats/detector.js';
