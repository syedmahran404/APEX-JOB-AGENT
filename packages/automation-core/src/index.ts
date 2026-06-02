// @apex/automation-core — reusable, browser-free infrastructure for the
// automation engine. Per-platform behavior lives in packages/platform-adapters/*.
//
// This package contains the adapter contract, the ApplyEvent taxonomy, the
// anti-detection layers (identity / behavior / pacing), CAPTCHA detection, the
// failure taxonomy, discovery (freshness + dedupe), layered selectors, the
// browser-pool interface + concurrency policy, and session lifecycle policy.
//
// Reference: docs/architecture/06-automation-engine.md.

export * from './contract.js';
export * from './events.js';
export * from './base-adapter.js';
export * from './selectors.js';
export * from './pool.js';
export * from './session.js';
export * from './redaction.js';

// Anti-detection layers.
export * from './anti-detection/identity.js';
export * from './anti-detection/behavior.js';
export * from './anti-detection/pacing.js';

// Safety.
export * from './safety/captcha.js';
export * from './safety/failure-taxonomy.js';

// Discovery.
export * from './discovery/freshness.js';
export * from './discovery/dedupe.js';
