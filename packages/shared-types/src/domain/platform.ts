import { z } from 'zod';

export const PlatformKey = z.enum([
  'linkedin',
  'naukri',
  'indeed',
  'internshala',
  'glassdoor',
  'foundit',
  'wellfound',
  'upwork',
]);
export type PlatformKey = z.infer<typeof PlatformKey>;

/** Canonical sequencing for multi-platform mode (Phase 1 §1.2). */
export const PLATFORM_SEQUENCE: ReadonlyArray<PlatformKey> = [
  'linkedin',
  'naukri',
  'indeed',
  'internshala',
  'glassdoor',
  'foundit',
  'wellfound',
  'upwork',
] as const;
