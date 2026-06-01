// Run state machine. Pure reducers — `(state, event) => state | RejectedTransition`.
// The orchestrator wraps these in a PG transaction with FOR UPDATE.
//
// Reference: docs/architecture/04-backend-design.md §4.2.

export type RunStatus = 'pending' | 'planning' | 'running' | 'paused' | 'stopped' | 'done' | 'failed';
export type RunControl = 'run' | 'pause' | 'stop';

export interface RunState {
  status: RunStatus;
  control: RunControl;
}

export type RunEventInput =
  | { kind: 'plan' }
  | { kind: 'planned' }
  | { kind: 'stage.started' }
  | { kind: 'stage.done.all' }
  | { kind: 'pause' }
  | { kind: 'pause.acked' } // worker finished its in-flight task
  | { kind: 'resume' }
  | { kind: 'stop' }
  | { kind: 'stop.acked' }
  | { kind: 'fail'; reason: string };

export type Transition =
  | { ok: true; next: RunState }
  | { ok: false; reason: string };

export function reduce(state: RunState, event: RunEventInput): Transition {
  switch (event.kind) {
    case 'plan':
      if (state.status === 'pending') return ok({ status: 'planning', control: state.control });
      return rej(state, event);
    case 'planned':
      if (state.status === 'planning') return ok({ status: 'running', control: state.control });
      return rej(state, event);
    case 'stage.started':
      if (state.status === 'running') return ok(state); // no-op
      return rej(state, event);
    case 'stage.done.all':
      if (state.status === 'running') return ok({ status: 'done', control: state.control });
      return rej(state, event);
    case 'pause':
      if (state.status === 'running' || state.status === 'planning') return ok({ ...state, control: 'pause' });
      return rej(state, event);
    case 'pause.acked':
      if (state.control === 'pause') return ok({ status: 'paused', control: 'pause' });
      return rej(state, event);
    case 'resume':
      if (state.status === 'paused') return ok({ status: 'running', control: 'run' });
      return rej(state, event);
    case 'stop':
      if (state.status !== 'done' && state.status !== 'stopped' && state.status !== 'failed')
        return ok({ ...state, control: 'stop' });
      return rej(state, event);
    case 'stop.acked':
      if (state.control === 'stop') return ok({ status: 'stopped', control: 'stop' });
      return rej(state, event);
    case 'fail':
      if (state.status !== 'done' && state.status !== 'stopped' && state.status !== 'failed')
        return ok({ status: 'failed', control: state.control });
      return rej(state, event);
  }
}

const ok = (next: RunState): Transition => ({ ok: true, next });
const rej = (state: RunState, event: RunEventInput): Transition => ({
  ok: false,
  reason: `Cannot apply ${event.kind} from status=${state.status} control=${state.control}`,
});
