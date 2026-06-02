import { describe, expect, it } from 'vitest';
import { reduce, type RunState } from '../state-machines/run.js';

const initial: RunState = { status: 'pending', control: 'run' };

describe('run state machine', () => {
  it('plan: pending → planning', () => {
    const r = reduce(initial, { kind: 'plan' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.next.status).toBe('planning');
  });

  it('planned: planning → running', () => {
    const planning: RunState = { status: 'planning', control: 'run' };
    const r = reduce(planning, { kind: 'planned' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.next.status).toBe('running');
  });

  it('pause: running → control=pause (status unchanged); pause.acked → paused', () => {
    const running: RunState = { status: 'running', control: 'run' };
    const a = reduce(running, { kind: 'pause' });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.next).toEqual({ status: 'running', control: 'pause' });
    const b = reduce(a.next, { kind: 'pause.acked' });
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.next).toEqual({ status: 'paused', control: 'pause' });
  });

  it('resume: paused → running with control=run', () => {
    const paused: RunState = { status: 'paused', control: 'pause' };
    const r = reduce(paused, { kind: 'resume' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.next).toEqual({ status: 'running', control: 'run' });
  });

  it('stage.done.all: running → done', () => {
    const running: RunState = { status: 'running', control: 'run' };
    const r = reduce(running, { kind: 'stage.done.all' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.next.status).toBe('done');
  });

  it('rejects invalid transitions', () => {
    const done: RunState = { status: 'done', control: 'run' };
    expect(reduce(done, { kind: 'pause' }).ok).toBe(false);
    expect(reduce(initial, { kind: 'planned' }).ok).toBe(false);
  });

  it('fail is permitted from any non-terminal state', () => {
    const running: RunState = { status: 'running', control: 'run' };
    const r = reduce(running, { kind: 'fail', reason: 'kaboom' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.next.status).toBe('failed');
    expect(reduce({ status: 'done', control: 'run' }, { kind: 'fail', reason: 'kaboom' }).ok).toBe(false);
  });
});
