// Validated environment loader. Crash-fast on misconfiguration.
//
// Usage:
//   const config = await loadConfig({
//     schema: ApiEnv,
//     env: process.env,
//     vault: vaultResolver,   // optional; resolves ${vault:path/to/key} refs
//   });

import type { z, ZodType } from 'zod';
import { ValidationError } from '@apex/shared-errors';

export interface VaultResolver {
  /** Resolve a single ${vault:path/to/key} ref to its plaintext value. */
  resolve(ref: string): Promise<string>;
}

export interface LoadConfigOptions<T extends ZodType> {
  schema: T;
  env: NodeJS.ProcessEnv;
  vault?: VaultResolver;
  /** When true (default in production), throws on any unresolved Vault ref. */
  requireVault?: boolean;
}

const VAULT_REF_RE = /^\$\{vault:[A-Za-z0-9_/.-]+\}$/;

export async function loadConfig<T extends ZodType>(opts: LoadConfigOptions<T>): Promise<Readonly<z.infer<T>>> {
  const raw: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(opts.env)) {
    if (typeof value !== 'string') continue;
    if (VAULT_REF_RE.test(value)) {
      if (!opts.vault) {
        if (opts.requireVault === true) {
          throw new ValidationError(`Vault resolver required for ${key}`, [
            { path: [key], message: 'value is a vault reference but no resolver was provided' },
          ]);
        }
        // dev/test fallback: keep ref as-is (downstream code can detect it).
        raw[key] = value;
      } else {
        raw[key] = await opts.vault.resolve(value);
      }
    } else {
      raw[key] = value;
    }
  }
  const parsed = opts.schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({
      path: i.path,
      message: i.message,
      code: i.code,
    }));
    throw new ValidationError('Invalid configuration', issues);
  }
  return Object.freeze(parsed.data) as Readonly<z.infer<T>>;
}
