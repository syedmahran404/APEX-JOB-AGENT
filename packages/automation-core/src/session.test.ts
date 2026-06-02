import { describe, it, expect } from 'vitest';
import {
  storageStateKey,
  decideContext,
  shouldEvict,
  CONTEXT_IDLE_TTL_MS,
  CONTEXT_MAX_AGE_MS,
  type ContextMeta,
} from './session.js';

const base: ContextMeta = {
  createdAtMs: 0,
  lastUsedAtMs: 0,
  sessionStatus: 'authenticated',
};

describe('session lifecycle (session recovery + state persistence)', () => {
  it('derives a stable, secret-free storage-state key per (user, platform)', () => {
    expect(storageStateKey('u-1', 'linkedin')).toBe('storage-state/u-1/linkedin.json.enc');
    expect(storageStateKey('u-1', 'naukri')).toBe('storage-state/u-1/naukri.json.enc');
  });

  it('reuses a warm, authenticated context within TTL', () => {
    const meta = { ...base, createdAtMs: 1000, lastUsedAtMs: 1000 };
    expect(decideContext(meta, 1000 + CONTEXT_IDLE_TTL_MS - 1)).toEqual({ action: 'reuse' });
  });

  it('refreshes a context idle past the TTL (session recovery: save & recreate)', () => {
    const meta = { ...base, createdAtMs: 0, lastUsedAtMs: 0 };
    expect(decideContext(meta, CONTEXT_IDLE_TTL_MS)).toEqual({ action: 'refresh', reason: 'idle-ttl' });
  });

  it('refreshes a context older than the 7-day hard cap even if recently used', () => {
    const now = CONTEXT_MAX_AGE_MS + 5000;
    const meta = { ...base, createdAtMs: 0, lastUsedAtMs: now - 10 };
    expect(decideContext(meta, now)).toEqual({ action: 'refresh', reason: 'max-age' });
  });

  it('re-authenticates when the session is expired / blocked / unknown', () => {
    expect(decideContext({ ...base, sessionStatus: 'expired' }, 0)).toEqual({ action: 're-auth', reason: 'expired' });
    expect(decideContext({ ...base, sessionStatus: 'blocked' }, 0)).toEqual({ action: 're-auth', reason: 'blocked' });
    expect(decideContext({ ...base, sessionStatus: 'unknown' }, 0)).toEqual({ action: 're-auth', reason: 'unknown' });
  });

  it('blocked status takes priority over TTL/age (account safety first)', () => {
    const meta = { ...base, sessionStatus: 'blocked' as const, createdAtMs: 0, lastUsedAtMs: 0 };
    expect(decideContext(meta, CONTEXT_MAX_AGE_MS + 1)).toEqual({ action: 're-auth', reason: 'blocked' });
  });

  it('shouldEvict fires once idle past the TTL', () => {
    expect(shouldEvict({ ...base, lastUsedAtMs: 0 }, CONTEXT_IDLE_TTL_MS - 1)).toBe(false);
    expect(shouldEvict({ ...base, lastUsedAtMs: 0 }, CONTEXT_IDLE_TTL_MS)).toBe(true);
  });
});
