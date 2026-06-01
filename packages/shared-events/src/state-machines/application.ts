// Application state machine. Pure reducer.

export type ApplicationStatus =
  | 'queued'
  | 'submitting'
  | 'submitted'
  | 'viewed'
  | 'shortlisted'
  | 'rejected'
  | 'interview_scheduled'
  | 'offer'
  | 'withdrawn'
  | 'closed_no_response'
  | 'skipped_human_required'
  | 'skipped_low_score'
  | 'skipped_stale'
  | 'skipped_external_ats'
  | 'skipped_recon_pending'
  | 'skipped_duplicate'
  | 'failed_selector_drift'
  | 'failed_platform_error'
  | 'duplicate';

export interface ApplicationState {
  status: ApplicationStatus;
}

export type ApplicationEventInput =
  | { kind: 'queue' }
  | { kind: 'open' }
  | { kind: 'submit' }
  | { kind: 'submit.confirmed' }
  | { kind: 'outcome.viewed' }
  | { kind: 'outcome.shortlisted' }
  | { kind: 'outcome.rejected' }
  | { kind: 'outcome.interview' }
  | { kind: 'outcome.offer' }
  | { kind: 'withdraw' }
  | { kind: 'no-response' }
  | { kind: 'skip'; reason: string; status: Extract<ApplicationStatus,
      | 'skipped_human_required'
      | 'skipped_low_score'
      | 'skipped_stale'
      | 'skipped_external_ats'
      | 'skipped_recon_pending'
      | 'skipped_duplicate'> }
  | { kind: 'fail'; reason: string; status: Extract<ApplicationStatus,
      | 'failed_selector_drift'
      | 'failed_platform_error'> };

export type ApplicationTransition =
  | { ok: true; next: ApplicationState }
  | { ok: false; reason: string };

export function reduceApplication(
  state: ApplicationState,
  event: ApplicationEventInput,
): ApplicationTransition {
  switch (event.kind) {
    case 'queue':
      if (state.status === 'queued') return ok(state);
      return rej(state, event);
    case 'open':
      if (state.status === 'queued') return ok({ status: 'submitting' });
      return rej(state, event);
    case 'submit':
      if (state.status === 'submitting') return ok(state);
      return rej(state, event);
    case 'submit.confirmed':
      if (state.status === 'submitting' || state.status === 'queued') return ok({ status: 'submitted' });
      return rej(state, event);
    case 'outcome.viewed':
      if (state.status === 'submitted') return ok({ status: 'viewed' });
      return rej(state, event);
    case 'outcome.shortlisted':
      if (['submitted', 'viewed'].includes(state.status)) return ok({ status: 'shortlisted' });
      return rej(state, event);
    case 'outcome.rejected':
      if (['submitted', 'viewed', 'shortlisted'].includes(state.status)) return ok({ status: 'rejected' });
      return rej(state, event);
    case 'outcome.interview':
      if (['submitted', 'viewed', 'shortlisted'].includes(state.status)) {
        return ok({ status: 'interview_scheduled' });
      }
      return rej(state, event);
    case 'outcome.offer':
      if (['submitted', 'viewed', 'shortlisted', 'interview_scheduled'].includes(state.status)) {
        return ok({ status: 'offer' });
      }
      return rej(state, event);
    case 'withdraw':
      if (TERMINAL.has(state.status)) return rej(state, event);
      return ok({ status: 'withdrawn' });
    case 'no-response':
      if (['submitted', 'viewed'].includes(state.status)) return ok({ status: 'closed_no_response' });
      return rej(state, event);
    case 'skip':
      if (state.status === 'queued' || state.status === 'submitting') return ok({ status: event.status });
      return rej(state, event);
    case 'fail':
      if (state.status === 'queued' || state.status === 'submitting') return ok({ status: event.status });
      return rej(state, event);
  }
}

const TERMINAL = new Set<ApplicationStatus>([
  'rejected',
  'offer',
  'withdrawn',
  'closed_no_response',
  'duplicate',
  'failed_selector_drift',
  'failed_platform_error',
  'skipped_human_required',
  'skipped_low_score',
  'skipped_stale',
  'skipped_external_ats',
  'skipped_recon_pending',
  'skipped_duplicate',
]);

const ok = (next: ApplicationState): ApplicationTransition => ({ ok: true, next });
const rej = (state: ApplicationState, event: ApplicationEventInput): ApplicationTransition => ({
  ok: false,
  reason: `Cannot apply ${event.kind} from application status=${state.status}`,
});
