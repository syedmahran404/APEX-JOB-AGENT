import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../load-config.js';

describe('loadConfig', () => {
  it('parses and freezes the result', async () => {
    const schema = z.object({ FOO: z.string(), N: z.coerce.number() });
    const result = await loadConfig({ schema, env: { FOO: 'bar', N: '7' } });
    expect(result.FOO).toBe('bar');
    expect(result.N).toBe(7);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('throws ValidationError on invalid env', async () => {
    const schema = z.object({ MUST_EXIST: z.string() });
    await expect(loadConfig({ schema, env: {} })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('resolves vault refs via the provided resolver', async () => {
    const schema = z.object({ DATABASE_URL: z.string() });
    const result = await loadConfig({
      schema,
      env: { DATABASE_URL: '${vault:db/url}' },
      vault: {
        resolve(ref) {
          expect(ref).toBe('${vault:db/url}');
          return Promise.resolve('postgres://x:y@host/db');
        },
      },
    });
    expect(result.DATABASE_URL).toBe('postgres://x:y@host/db');
  });

  it('errors if vault ref present and requireVault=true with no resolver', async () => {
    const schema = z.object({ X: z.string() });
    await expect(
      loadConfig({ schema, env: { X: '${vault:x}' }, requireVault: true }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });
});
