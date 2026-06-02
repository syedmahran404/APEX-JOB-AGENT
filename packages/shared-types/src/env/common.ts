// Common environment fields used by every backend service.

import { z } from 'zod';

export const NodeEnv = z.enum(['development', 'test', 'staging', 'production']);
export type NodeEnv = z.infer<typeof NodeEnv>;

export const LogLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);
export type LogLevel = z.infer<typeof LogLevel>;

/** A reference to a Vault path; resolved at boot by shared-config. */
const VaultRefRegex = /^\$\{vault:[A-Za-z0-9_/.-]+\}$/;
export const VaultRef = z.string().regex(VaultRefRegex, 'Expected ${vault:path/to/key} reference');

export const SecretOrVaultRef = z.union([
  VaultRef,
  z.string().min(1, 'Secret must be non-empty or a vault ref'),
]);

/** Common base shared by every service. */
export const CommonEnv = z.object({
  NODE_ENV: NodeEnv.default('development'),
  LOG_LEVEL: LogLevel.default('info'),
  SERVICE_NAME: z.string().min(1),
  SERVICE_VERSION: z.string().default('0.1.0'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
});
export type CommonEnv = z.infer<typeof CommonEnv>;
