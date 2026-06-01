// PlatformManager — adapter registry + DB platform-id resolution.
// Adapters are registered at worker startup; the engine queries by
// platform UUID (because run.requested_platforms[] holds UUIDs).

import type { Platform, PrismaClient } from '@apex/db';
import { NotFoundError } from '@apex/shared-errors';
import type { Logger } from '@apex/shared-logger';
import type { PlatformManager } from './interfaces.js';
import type { AdapterCaps, PlatformAdapter, PlatformKey } from '../types/adapter.js';

export interface DefaultPlatformManagerOptions {
  logger: Logger;
  prisma: PrismaClient;
}

export class DefaultPlatformManager implements PlatformManager {
  private readonly logger: Logger;
  private readonly prisma: PrismaClient;
  private readonly byKey = new Map<PlatformKey, PlatformAdapter>();
  private platformsCache: Map<string, Platform> | null = null;

  constructor(opts: DefaultPlatformManagerOptions) {
    this.logger = opts.logger.child({ component: 'platform-manager' });
    this.prisma = opts.prisma;
  }

  register(adapter: PlatformAdapter): void {
    if (this.byKey.has(adapter.key)) {
      this.logger.warn({ key: adapter.key }, 'replacing already-registered adapter');
    }
    this.byKey.set(adapter.key, adapter);
    this.logger.info(
      { key: adapter.key, version: adapter.version, verified: adapter.capabilities.verifiedAgainstLive },
      'adapter registered',
    );
  }

  has(key: PlatformKey): boolean {
    return this.byKey.has(key);
  }

  get(key: PlatformKey): PlatformAdapter {
    const a = this.byKey.get(key);
    if (!a) throw new NotFoundError('Adapter not registered', { key });
    return a;
  }

  list(): ReadonlyArray<{ key: PlatformKey; version: string; capabilities: AdapterCaps }> {
    return Array.from(this.byKey.values()).map((a) => ({
      key: a.key,
      version: a.version,
      capabilities: a.capabilities,
    }));
  }

  async resolveById(platformId: string): Promise<PlatformAdapter> {
    if (!this.platformsCache) await this.refreshPlatforms();
    const platform = this.platformsCache?.get(platformId);
    if (!platform) {
      // Refresh once more in case the seed ran after the worker started.
      await this.refreshPlatforms();
    }
    const refreshed = this.platformsCache?.get(platformId);
    if (!refreshed) throw new NotFoundError('Platform row not found', { platformId });
    const adapter = this.byKey.get(refreshed.key as PlatformKey);
    if (!adapter) throw new NotFoundError('Adapter not registered for platform', { key: refreshed.key });
    return adapter;
  }

  private async refreshPlatforms(): Promise<void> {
    const rows = await this.prisma.platform.findMany();
    this.platformsCache = new Map(rows.map((p) => [p.id, p]));
    this.logger.debug({ count: rows.length }, 'platforms cache refreshed');
  }
}
