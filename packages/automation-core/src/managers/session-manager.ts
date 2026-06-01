// SessionManager — persists / restores Playwright `storageState` per platform
// account. Encryption-at-rest is delegated to S3 server-side encryption with
// our KMS key (bucket policy enforces SSE-KMS). The per-user DEK envelope
// for storage states is a Phase 8 hardening item per the audit.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { BrowserContext } from 'playwright';
import type { Logger } from '@apex/shared-logger';
import type { PlatformSession, PlatformSessionRepository } from '@apex/db';
import type { SessionManager } from './interfaces.js';
import { newUlid } from '../utils/ulid.js';

export interface ObjectStore {
  /** Upload a file from disk path to a storage URI. Returns the canonical URI. */
  putFile(localPath: string, key: string, opts?: { contentType?: string }): Promise<string>;
  /** Download a key to a local path. */
  getToFile(key: string, localPath: string): Promise<void>;
  /** Best-effort: delete a key. */
  delete(key: string): Promise<void>;
}

export interface DefaultSessionManagerOptions {
  logger: Logger;
  sessionRepo: PlatformSessionRepository;
  store: ObjectStore;
  /** Bucket prefix for storage-state files. */
  prefix: string;
  /** TTL applied to newly-persisted sessions (default 7 days). */
  defaultTtlMs?: number;
}

export class DefaultSessionManager implements SessionManager {
  private readonly logger: Logger;
  private readonly defaultTtlMs: number;

  constructor(private readonly opts: DefaultSessionManagerOptions) {
    this.logger = opts.logger.child({ component: 'session-manager' });
    this.defaultTtlMs = opts.defaultTtlMs ?? 7 * 24 * 60 * 60_000;
  }

  async restoreLatest(accountId: string): Promise<{ uri: string; expiresAt: Date | null } | null> {
    const session = await this.opts.sessionRepo.findLatestFresh(accountId);
    if (!session) return null;
    return { uri: session.storageUri, expiresAt: session.expiresAt };
  }

  async persist(
    accountId: string,
    context: BrowserContext,
    persistOpts?: { ttlMin?: number },
  ): Promise<PlatformSession> {
    const tmp = path.join(os.tmpdir(), `apex-storage-state-${newUlid()}.json`);
    try {
      await context.storageState({ path: tmp });
      const key = `${this.opts.prefix.replace(/\/$/, '')}/${accountId}/${newUlid()}.json`;
      const uri = await this.opts.store.putFile(tmp, key, { contentType: 'application/json' });
      const ttlMs = persistOpts?.ttlMin !== undefined ? persistOpts.ttlMin * 60_000 : this.defaultTtlMs;
      const expiresAt = new Date(Date.now() + ttlMs);
      const session = await this.opts.sessionRepo.create({
        accountId,
        storageUri: uri,
        expiresAt,
        health: 'fresh',
      });
      this.logger.debug({ accountId, uri, expiresAt }, 'persisted session storage state');
      return session;
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  async markStale(accountId: string): Promise<void> {
    const count = await this.opts.sessionRepo.markAllStaleForAccount(accountId);
    this.logger.info({ accountId, count }, 'marked sessions stale for account');
  }
}

/**
 * Local-disk ObjectStore — used by self-hosted deployments and CI tests.
 * Production uses an S3 implementation that lives in apps/automation-worker/infra.
 */
export class LocalObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  async putFile(localPath: string, key: string): Promise<string> {
    const dest = path.join(this.root, key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(localPath, dest);
    return `file://${dest}`;
  }

  async getToFile(key: string, localPath: string): Promise<void> {
    const src = path.join(this.root, key);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.copyFile(src, localPath);
  }

  async delete(key: string): Promise<void> {
    await fs.rm(path.join(this.root, key), { force: true });
  }
}
