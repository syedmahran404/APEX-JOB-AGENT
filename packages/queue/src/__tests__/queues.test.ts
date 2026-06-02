import { describe, expect, it } from 'vitest';
import { QUEUES, dlqName, DEFAULT_RETRY_POLICY, type QueueName } from '../queues.js';

describe('queue catalog', () => {
  it('every QUEUES value is namespaced under q:', () => {
    for (const name of Object.values(QUEUES)) {
      expect(name).toMatch(/^q:[a-z0-9.-]+$/);
    }
  });

  it('every QUEUES key resolves to a unique value', () => {
    const values = Object.values(QUEUES);
    expect(new Set(values).size).toBe(values.length);
  });

  it('dlqName appends .dlq once', () => {
    const q: QueueName = QUEUES.PlatformApply;
    expect(dlqName(q)).toBe(`${q}.dlq`);
    // No double-suffixing of .dlq.dlq when called on a regular name.
    expect(dlqName(q).endsWith('.dlq.dlq')).toBe(false);
  });

  it('default retry policy has bounded attempts and exponential backoff', () => {
    expect(DEFAULT_RETRY_POLICY.attempts).toBe(3);
    expect(DEFAULT_RETRY_POLICY.backoff.type).toBe('exponential');
    expect(DEFAULT_RETRY_POLICY.backoff.delay).toBeGreaterThan(0);
  });

  it('default retry policy keeps completed jobs bounded for observability', () => {
    expect(DEFAULT_RETRY_POLICY.removeOnComplete.age).toBeGreaterThan(0);
    expect(DEFAULT_RETRY_POLICY.removeOnFail.age).toBeGreaterThan(
      DEFAULT_RETRY_POLICY.removeOnComplete.age,
    );
  });
});
