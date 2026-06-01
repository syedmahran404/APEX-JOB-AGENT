// Unit tests for the topic ACL logic and helpers re-exported through realtime.
// We test the pure topic builders + parser (delegated to @apex/shared-types).

import { describe, expect, it } from 'vitest';
import { Events } from '@apex/shared-types';

describe('realtime topics', () => {
  it('userTopic produces the canonical channel name', () => {
    const topic = Events.userTopic('00000000-0000-4000-8000-000000000001');
    expect(topic).toBe('events:user:00000000-0000-4000-8000-000000000001');
  });

  it('runTopic produces the canonical channel name', () => {
    const topic = Events.runTopic('00000000-0000-4000-8000-000000000002');
    expect(topic).toBe('events:run:00000000-0000-4000-8000-000000000002');
  });

  it('parseTopic extracts kind and id', () => {
    expect(Events.parseTopic('events:user:00000000-0000-4000-8000-000000000001')).toEqual({
      kind: 'user',
      userId: '00000000-0000-4000-8000-000000000001',
    });
    expect(Events.parseTopic('events:run:00000000-0000-4000-8000-000000000002')).toEqual({
      kind: 'run',
      runId: '00000000-0000-4000-8000-000000000002',
    });
    expect(Events.parseTopic('events:tenant:00000000-0000-4000-8000-000000000003')).toEqual({
      kind: 'tenant',
      tenantId: '00000000-0000-4000-8000-000000000003',
    });
  });

  it('parseTopic rejects malformed topics', () => {
    expect(Events.parseTopic('foo:bar:baz')).toBeNull();
    expect(Events.parseTopic('events:user:not-a-uuid')).toBeNull();
    expect(Events.parseTopic('events:run')).toBeNull();
    expect(Events.parseTopic('')).toBeNull();
  });

  it('topic builders reject non-UUID input', () => {
    expect(() => Events.userTopic('not-a-uuid')).toThrow();
    expect(() => Events.runTopic('123')).toThrow();
  });
});
