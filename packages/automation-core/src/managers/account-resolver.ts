// AccountResolver — surfaces (account, permission, latest session) for the
// engine. Returns null when the user has no account on the platform; the
// engine treats that as "skip stage with reason no_account".

import type { PlatformAccountRepository, PlatformPermissionRepository, PlatformSessionRepository } from '@apex/db';
import type { AccountResolver, AccountSnapshot } from './interfaces.js';

export interface DefaultAccountResolverOptions {
  accountRepo: PlatformAccountRepository;
  permissionRepo: PlatformPermissionRepository;
  sessionRepo: PlatformSessionRepository;
}

export class DefaultAccountResolver implements AccountResolver {
  constructor(private readonly opts: DefaultAccountResolverOptions) {}

  async resolve(userId: string, platformId: string): Promise<AccountSnapshot | null> {
    const account = await this.opts.accountRepo.findByUserPlatform(userId, platformId);
    if (!account) return null;
    const permission = await this.opts.permissionRepo.getOrDefaults(userId, platformId);
    const latestSession = await this.opts.sessionRepo.findLatestFresh(account.id);
    return { account, permission, latestSession };
  }
}
