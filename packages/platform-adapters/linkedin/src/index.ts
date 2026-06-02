// @apex/platform-adapter-linkedin — the LinkedIn PlatformAdapter.
//
// Pure logic (parsers, selector catalog, capabilities) is implemented and
// tested here. Browser-driving methods are supplied at runtime by
// apps/automation-worker via the AdapterContext.
//
// Reference: docs/architecture/06-automation-engine.md §3, §4.

export * from './adapter.js';
export * from './parse.js';
export * from './selectors.js';
