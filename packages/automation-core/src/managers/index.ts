// Manager implementations — concrete classes consumed by apps/automation-worker.
// Type-only `interfaces.ts` is exported separately by automation-core's root.

export { DefaultBrowserManager, type DefaultBrowserManagerOptions } from './browser-manager.js';
export {
  DefaultSessionManager,
  LocalObjectStore,
  type ObjectStore,
  type DefaultSessionManagerOptions,
} from './session-manager.js';
export { DefaultPlatformManager, type DefaultPlatformManagerOptions } from './platform-manager.js';
export { DefaultStateManager, type DefaultStateManagerOptions } from './state-manager.js';
export { DefaultRecoveryManager, type DefaultRecoveryManagerOptions } from './recovery-manager.js';
export { DefaultCaptchaDetectionManager } from './captcha-manager.js';
export { DefaultNotificationManager, type DefaultNotificationManagerOptions } from './notification-manager.js';
export { DefaultJobCollectionManager, type DefaultJobCollectionManagerOptions } from './job-collection-manager.js';
export { DefaultJobFilteringManager, type DefaultJobFilteringManagerOptions } from './job-filtering-manager.js';
export { DefaultJobPriorityManager } from './job-priority-manager.js';
export {
  DefaultApplicationExecutionManager,
  type DefaultApplicationExecutionManagerOptions,
} from './application-execution-manager.js';
export { DefaultScreenshotManager, type DefaultScreenshotManagerOptions } from './screenshot-manager.js';
export { DefaultAuditManager } from './audit-manager.js';
export { DefaultQueueManager, RUN_QUEUE, type DefaultQueueManagerOptions, type RunTaskPayload } from './queue-manager.js';
export { DefaultEventDispatcher, type DefaultEventDispatcherOptions } from './event-dispatcher.js';
export { DefaultPacingManager, type DefaultPacingManagerOptions } from './pacing-manager.js';
export { DefaultAccountResolver, type DefaultAccountResolverOptions } from './account-resolver.js';
export { DefaultJobScorer } from './job-scorer.js';
export { DefaultJobUpserter, type DefaultJobUpserterOptions } from './job-upserter.js';
export { DefaultKnowledgeProvider, type DefaultKnowledgeProviderOptions } from './knowledge-provider.js';
