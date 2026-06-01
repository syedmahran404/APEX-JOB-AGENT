import { z } from 'zod';

export const HealthCheckStatus = z.enum(['ok', 'degraded', 'down']);
export type HealthCheckStatus = z.infer<typeof HealthCheckStatus>;

export const HealthCheckResponse = z.object({
  status: HealthCheckStatus,
  service: z.string(),
  version: z.string(),
  uptimeSec: z.number().nonnegative(),
  checks: z.record(z.string(), z.object({ status: HealthCheckStatus, latencyMs: z.number().nonnegative().optional(), error: z.string().optional() })),
});
export type HealthCheckResponse = z.infer<typeof HealthCheckResponse>;
