// Integration tests for the M0 repositories + audit hash-chain trigger.
// Opt-in via `RUN_INTEGRATION=1 pnpm --filter @apex/db test:integration`.

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UserRepository, AuditRepository, SessionRepository, IdempotencyRepository, runInTransaction, appendOutbox } from '../../index.js';
import { startTestDb, stopTestDb, TEST_TENANT_ID, type IntegrationContext } from './setup.js';

describe.runIf(process.env.RUN_INTEGRATION === '1')('DB integration', () => {
  let ctx: IntegrationContext | null = null;

  beforeAll(async () => {
    ctx = await startTestDb();
  });

  afterAll(async () => {
    await stopTestDb(ctx);
  });

  it('UserRepository.create + findByEmail round-trip', async () => {
    if (!ctx) throw new TypeError('ctx not initialized');
    const userRepo = new UserRepository(ctx.prisma);
    const user = await userRepo.create({
      tenantId: TEST_TENANT_ID,
      email: 'alice@apex.test',
      displayName: 'Alice',
      passwordHash: 'argon2$placeholder',
      dataKeyId: 'vault:test/dek',
      dataKeyWrapped: randomBytes(64),
    });
    expect(user.email).toBe('alice@apex.test');
    expect(user.tenantId).toBe(TEST_TENANT_ID);
    expect(user.status).toBe('active');

    const fetched = await userRepo.findByEmail(TEST_TENANT_ID, 'alice@apex.test');
    expect(fetched?.id).toBe(user.id);
  });

  it('SessionRepository creates a session with hashed token; cookie is recoverable', async () => {
    if (!ctx) throw new TypeError('ctx not initialized');
    const userRepo = new UserRepository(ctx.prisma);
    const sessionRepo = new SessionRepository(ctx.prisma);
    const user = await userRepo.create({
      tenantId: TEST_TENANT_ID,
      email: 'session@apex.test',
      displayName: 'Session User',
      passwordHash: 'argon2$placeholder',
      dataKeyId: 'vault:test/dek',
      dataKeyWrapped: randomBytes(64),
    });

    const created = await sessionRepo.create({ userId: user.id, ttlSec: 3600 });
    expect(created.cookieSecret.length).toBeGreaterThan(0);

    const found = await sessionRepo.findByCookieSecret(created.cookieSecret);
    expect(found?.id).toBe(created.id);

    // Wrong cookie returns null.
    const notFound = await sessionRepo.findByCookieSecret('wrong-cookie-value');
    expect(notFound).toBeNull();

    // After revoke, the lookup returns null.
    await sessionRepo.revoke(created.id);
    const afterRevoke = await sessionRepo.findByCookieSecret(created.cookieSecret);
    expect(afterRevoke).toBeNull();
  });

  it('AuditRepository.append populates a hash chain that verifies', async () => {
    if (!ctx) throw new TypeError('ctx not initialized');
    const auditRepo = new AuditRepository(ctx.prisma);
    for (let i = 0; i < 5; i++) {
      await auditRepo.append({
        tenantId: TEST_TENANT_ID,
        actorKind: 'system',
        action: `test.event.${String(i)}`,
        metadata: { i },
      });
    }
    const result = await auditRepo.verifyChain(TEST_TENANT_ID);
    expect(result.ok).toBe(true);
  });

  it('audit_log refuses UPDATE and DELETE (trigger enforces append-only)', async () => {
    if (!ctx) throw new TypeError('ctx not initialized');
    const auditRepo = new AuditRepository(ctx.prisma);
    await auditRepo.append({ tenantId: TEST_TENANT_ID, actorKind: 'system', action: 'try.update' });

    await expect(
      ctx.prisma.$executeRawUnsafe('UPDATE audit_log SET action = $1 WHERE action = $2', 'mutated', 'try.update'),
    ).rejects.toThrow(/append-only/i);

    await expect(
      ctx.prisma.$executeRawUnsafe('DELETE FROM audit_log WHERE action = $1', 'try.update'),
    ).rejects.toThrow(/append-only/i);
  });

  it('IdempotencyRepository.remember replays cached response on identical request', async () => {
    if (!ctx) throw new TypeError('ctx not initialized');
    const userRepo = new UserRepository(ctx.prisma);
    const idemRepo = new IdempotencyRepository(ctx.prisma);
    const user = await userRepo.create({
      tenantId: TEST_TENANT_ID,
      email: 'idem@apex.test',
      displayName: 'Idem',
      passwordHash: 'argon2$placeholder',
      dataKeyId: 'vault:test/dek',
      dataKeyWrapped: randomBytes(64),
    });

    const first = await idemRepo.remember({
      userId: user.id,
      key: 'op-1',
      method: 'POST',
      path: '/runs',
      requestBody: { mode: 'multi', target: 20 },
      responseStatus: 202,
      responseEnvelope: { ok: true, runId: 'r-1' },
      ttlSec: 3600,
    });
    expect(first.hit).toBe(false);

    // Same body → cached replay.
    const second = await idemRepo.remember({
      userId: user.id,
      key: 'op-1',
      method: 'POST',
      path: '/runs',
      requestBody: { mode: 'multi', target: 20 },
      responseStatus: 0, // ignored on hit
      responseEnvelope: {}, // ignored on hit
      ttlSec: 3600,
    });
    expect(second.hit).toBe(true);
    expect(second.status).toBe(202);
    expect(second.envelope).toMatchObject({ ok: true, runId: 'r-1' });
  });

  it('IdempotencyRepository.remember rejects when same key is reused with different body', async () => {
    if (!ctx) throw new TypeError('ctx not initialized');
    const userRepo = new UserRepository(ctx.prisma);
    const idemRepo = new IdempotencyRepository(ctx.prisma);
    const user = await userRepo.create({
      tenantId: TEST_TENANT_ID,
      email: 'idem2@apex.test',
      displayName: 'Idem2',
      passwordHash: 'argon2$placeholder',
      dataKeyId: 'vault:test/dek',
      dataKeyWrapped: randomBytes(64),
    });

    await idemRepo.remember({
      userId: user.id,
      key: 'op-A',
      method: 'POST',
      path: '/runs',
      requestBody: { v: 1 },
      responseStatus: 202,
      responseEnvelope: { ok: true },
      ttlSec: 3600,
    });
    await expect(
      idemRepo.remember({
        userId: user.id,
        key: 'op-A',
        method: 'POST',
        path: '/runs',
        requestBody: { v: 2 },
        responseStatus: 202,
        responseEnvelope: { ok: true },
        ttlSec: 3600,
      }),
    ).rejects.toMatchObject({ code: 'idempotency_mismatch' });
  });

  it('IdempotencyRepository.reapExpired deletes expired rows only', async () => {
    if (!ctx) throw new TypeError('ctx not initialized');
    const userRepo = new UserRepository(ctx.prisma);
    const idemRepo = new IdempotencyRepository(ctx.prisma);
    const user = await userRepo.create({
      tenantId: TEST_TENANT_ID,
      email: 'idem3@apex.test',
      displayName: 'Idem3',
      passwordHash: 'argon2$placeholder',
      dataKeyId: 'vault:test/dek',
      dataKeyWrapped: randomBytes(64),
    });
    await idemRepo.remember({
      userId: user.id,
      key: 'fresh',
      method: 'POST',
      path: '/runs',
      requestBody: { v: 1 },
      responseStatus: 200,
      responseEnvelope: {},
      ttlSec: 3600,
    });
    await idemRepo.remember({
      userId: user.id,
      key: 'old',
      method: 'POST',
      path: '/runs',
      requestBody: { v: 2 },
      responseStatus: 200,
      responseEnvelope: {},
      ttlSec: -10, // already expired
    });
    const removed = await idemRepo.reapExpired();
    expect(removed).toBeGreaterThanOrEqual(1);
    const fresh = await idemRepo.recall(user.id, 'fresh');
    expect(fresh.hit).toBe(true);
    const old = await idemRepo.recall(user.id, 'old');
    expect(old.hit).toBe(false);
  });

  it('runInTransaction commits on success and writes outbox + audit atomically', async () => {
    if (!ctx) throw new TypeError('ctx not initialized');
    const auditRepo = new AuditRepository(ctx.prisma);
    const aggId = '00000000-0000-4000-8000-000000000099';

    await runInTransaction(ctx.prisma, async (tx) => {
      await auditRepo.append(
        {
          tenantId: TEST_TENANT_ID,
          actorKind: 'system',
          action: 'tx.test',
          targetKind: 'run',
          targetId: aggId,
          metadata: { reason: 'integration' },
        },
        tx,
      );
      await appendOutbox(tx, {
        tenantId: TEST_TENANT_ID,
        aggregate: 'run',
        aggregateId: aggId,
        topic: `events:run:${aggId}`,
        payload: { kind: 'test.fired' },
      });
    });

    const outbox = await ctx.prisma.outboxEvent.findMany({ where: { aggregateId: aggId } });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.deliveredAt).toBeNull();
  });

  it('runInTransaction rolls back atomically when handler throws', async () => {
    if (!ctx) throw new TypeError('ctx not initialized');
    const auditRepo = new AuditRepository(ctx.prisma);
    const aggId = '00000000-0000-4000-8000-0000000000aa';

    await expect(
      runInTransaction(ctx.prisma, async (tx) => {
        await auditRepo.append(
          {
            tenantId: TEST_TENANT_ID,
            actorKind: 'system',
            action: 'tx.rollback',
            targetId: aggId,
          },
          tx,
        );
        await appendOutbox(tx, {
          tenantId: TEST_TENANT_ID,
          aggregate: 'run',
          aggregateId: aggId,
          topic: `events:run:${aggId}`,
          payload: { kind: 'should.not.persist' },
        });
        throw new TypeError('boom');
      }),
    ).rejects.toThrow(/boom/);

    const outbox = await ctx.prisma.outboxEvent.findMany({ where: { aggregateId: aggId } });
    expect(outbox).toHaveLength(0);
    const audits = await ctx.prisma.auditLog.findMany({ where: { action: 'tx.rollback' } });
    expect(audits).toHaveLength(0);
  });
});
