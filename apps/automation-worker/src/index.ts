// @apex/automation-worker — Playwright execution runtime.
export * from './browser/driver.js';
export { PlaywrightBrowserDriver, type PlaywrightDriverOptions } from './browser/playwright-driver.js';
export {
  PooledBrowserManager,
  type StorageStateStore,
  type ContextProvisioner,
  type PooledBrowserManagerOptions,
} from './browser/pool.js';
export {
  LinkedInRuntimeAdapter,
  type LinkedInRuntimeDeps,
  type AnswerProvider,
  type AnswerSourceKind,
  type RuntimeLogger,
} from './adapters/linkedin-runtime.js';
export { resolveOnPage, strategyToSelector, type ResolvedSelector } from './adapters/page-selectors.js';
export { ScreenshotCapturer, type ArtifactStore, type CaptureRequest } from './reporting/screenshots.js';
export {
  redeemCredentials,
  withCredentials,
  type CredentialRedeemer,
  type PlatformCredentials,
} from './leases/credentials.js';
export { ApplyRunner, type ApplyRunnerDeps, type ApplyRunInput, type ApplyResult, type ApplyReporter } from './tasks/apply-runner.js';
export { registerConsumers, type TaskHandlers, type ConsumerOptions, type RegisteredWorker } from './tasks/consumers.js';
