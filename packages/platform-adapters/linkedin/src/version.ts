// LinkedIn adapter version. Bumped on every selector-changing release.
// The engine pins the active version on each `applications.adapter_version`
// row (audit fix C5), so post-mortem rollups can attribute drift incidents
// to a specific adapter version.

export const ADAPTER_VERSION = '0.1.0';
