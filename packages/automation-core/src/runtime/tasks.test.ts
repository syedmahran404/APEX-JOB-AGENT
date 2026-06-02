import { describe, it, expect } from 'vitest';
import {
  parseDiscoveryTask,
  parseApplyTask,
  parseSessionRefreshTask,
  parseScheduleFireTask,
  DiscoveryTask,
  ApplyTask,
} from './tasks.js';

const UUID = '00000000-0000-4000-8000-000000000001';
const UUID2 = '00000000-0000-4000-8000-000000000002';

describe('runtime/tasks (queue payload schemas)', () => {
  it('parses a valid discovery task and applies defaults', () => {
    const t = parseDiscoveryTask({
      kind: 'discovery',
      runId: UUID,
      stageId: UUID2,
      userId: UUID,
      tenantId: UUID2,
      platformKey: 'linkedin',
      filters: { query: 'backend engineer' },
      idempotencyKey: 'disc-1',
    });
    expect(t.kind).toBe('discovery');
    expect(t.profile).toBe('STRICT_DEFAULT'); // default
    expect(t.attempt).toBe(0); // default
    expect(t.dryRun).toBe(false); // default
    expect(t.filters.query).toBe('backend engineer');
  });

  it('parses a valid apply task', () => {
    const t = parseApplyTask({
      kind: 'apply',
      runId: UUID,
      stageId: UUID2,
      userId: UUID,
      tenantId: UUID2,
      platformKey: 'linkedin',
      applicationId: UUID,
      jobExternalId: '3856120947',
      jobUrl: 'https://www.linkedin.com/jobs/view/3856120947',
      resumeVersionId: UUID2,
      idempotencyKey: 'app-1',
    });
    expect(t.kind).toBe('apply');
    expect(t.allowAiAnswers).toBe(true);
    expect(t.mode).toBe('assisted');
  });

  it('parses a session-refresh task with a typed reason', () => {
    const t = parseSessionRefreshTask({
      kind: 'session_refresh',
      runId: UUID,
      stageId: UUID2,
      userId: UUID,
      tenantId: UUID2,
      platformKey: 'linkedin',
      reason: 'idle-ttl',
    });
    expect(t.reason).toBe('idle-ttl');
  });

  it('parses a schedule-fire task', () => {
    const t = parseScheduleFireTask({
      kind: 'schedule_fire',
      scheduleId: UUID,
      userId: UUID2,
      tenantId: UUID,
      templateId: UUID2,
      firedAt: '2026-06-02T12:00:00.000Z',
    });
    expect(t.scheduleId).toBe(UUID);
  });

  it('rejects malformed payloads', () => {
    expect(() => parseDiscoveryTask({ kind: 'discovery' })).toThrow();
    expect(() => parseApplyTask({ kind: 'apply', jobUrl: 'not-a-url' })).toThrow();
    expect(() => DiscoveryTask.parse({ kind: 'apply' })).toThrow();
    expect(() => ApplyTask.parse({ kind: 'discovery' })).toThrow();
  });

  it('rejects a discovery task with an empty query', () => {
    expect(() =>
      parseDiscoveryTask({
        kind: 'discovery',
        runId: UUID,
        stageId: UUID2,
        userId: UUID,
        tenantId: UUID2,
        platformKey: 'linkedin',
        filters: { query: '' },
        idempotencyKey: 'x',
      }),
    ).toThrow();
  });
});
