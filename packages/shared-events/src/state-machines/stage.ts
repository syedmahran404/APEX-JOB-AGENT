// Stage state machine. Pure reducer.
// Reference: docs/architecture/04-backend-design.md §4.2.

export type StageStatus = 'pending' | 'discovering' | 'applying' | 'done' | 'skipped' | 'failed';

export interface StageState {
  status: StageStatus;
  appliedCount: number;
  target: number;
}

export type StageEventInput =
  | { kind: 'discovery.start' }
  | { kind: 'discovery.complete' }
  | { kind: 'apply.queued' }
  | { kind: 'apply.submitted' }
  | { kind: 'apply.skipped' }
  | { kind: 'apply.failed' }
  | { kind: 'no-eligible-jobs' }
  | { kind: 'skip'; reason: string }
  | { kind: 'fail'; reason: string };

export type StageTransition =
  | { ok: true; next: StageState }
  | { ok: false; reason: string };

export function reduceStage(state: StageState, event: StageEventInput): StageTransition {
  switch (event.kind) {
    case 'discovery.start':
      if (state.status === 'pending') return ok({ ...state, status: 'discovering' });
      return rej(state, event);
    case 'discovery.complete':
      if (state.status === 'discovering') return ok({ ...state, status: 'applying' });
      return rej(state, event);
    case 'apply.queued':
      if (state.status === 'applying') return ok(state);
      return rej(state, event);
    case 'apply.submitted': {
      if (state.status !== 'applying') return rej(state, event);
      const next = { ...state, appliedCount: state.appliedCount + 1 };
      if (next.appliedCount >= state.target) return ok({ ...next, status: 'done' });
      return ok(next);
    }
    case 'apply.skipped':
      if (state.status === 'applying') return ok(state);
      return rej(state, event);
    case 'apply.failed':
      if (state.status === 'applying') return ok(state);
      return rej(state, event);
    case 'no-eligible-jobs':
      if (state.status === 'discovering' || state.status === 'applying') {
        return ok({ ...state, status: 'done' });
      }
      return rej(state, event);
    case 'skip':
      if (state.status === 'pending' || state.status === 'discovering' || state.status === 'applying') {
        return ok({ ...state, status: 'skipped' });
      }
      return rej(state, event);
    case 'fail':
      if (state.status === 'done' || state.status === 'failed' || state.status === 'skipped') {
        return rej(state, event);
      }
      return ok({ ...state, status: 'failed' });
  }
}

const ok = (next: StageState): StageTransition => ({ ok: true, next });
const rej = (state: StageState, event: StageEventInput): StageTransition => ({
  ok: false,
  reason: `Cannot apply ${event.kind} from stage status=${state.status}`,
});
