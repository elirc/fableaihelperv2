import type { PublicError, SessionEvent, SessionMetrics, SessionState } from '../../shared/domain';

/**
 * Pure session state machine for the coach view (spec §8.4).
 * All provider events carry a sessionId; events for retired sessions and
 * non-monotonic answer sequences are ignored (spec §14 rules 3-4).
 */

export interface CoachState {
  sessionId: string | null;
  phase: SessionState;
  transcript: string;
  transcriptLanguage?: string;
  answer: string;
  lastSequence: number;
  metrics: SessionMetrics | null;
  error: PublicError | null;
  elapsedMs: number;
  level: { rms: number; peak: number };
  silentSoFar: boolean;
}

export const initialCoachState: CoachState = {
  sessionId: null,
  phase: 'checking',
  transcript: '',
  answer: '',
  lastSequence: -1,
  metrics: null,
  error: null,
  elapsedMs: 0,
  level: { rms: 0, peak: 0 },
  silentSoFar: true,
};

export type CoachAction =
  | { type: 'configured'; ready: boolean }
  | { type: 'arm'; sessionId: string }
  | { type: 'capture-started' }
  | { type: 'capture-failed'; error: PublicError }
  | { type: 'meter'; rms: number; peak: number; elapsedMs: number }
  | { type: 'stop-requested' }
  | { type: 'cancel-requested' }
  | { type: 'cancel-confirmed'; sessionId: string }
  | { type: 'submitted'; sessionId: string }
  | { type: 'regenerate'; sessionId: string; transcript: string }
  | { type: 'edit-transcript'; text: string }
  | { type: 'session-event'; event: SessionEvent }
  | { type: 'reset' };

const ACTIVE_PHASES: SessionState[] = [
  'arming_capture',
  'recording',
  'encoding',
  'transcribing',
  'generating',
];

export function isActivePhase(phase: SessionState): boolean {
  return ACTIVE_PHASES.includes(phase);
}

export function coachReducer(state: CoachState, action: CoachAction): CoachState {
  switch (action.type) {
    case 'configured':
      if (state.phase !== 'checking' && state.phase !== 'unconfigured') return state;
      return { ...state, phase: action.ready ? 'ready' : 'unconfigured' };

    case 'arm':
      return {
        ...initialCoachState,
        phase: 'arming_capture',
        sessionId: action.sessionId,
      };

    case 'capture-started':
      if (state.phase !== 'arming_capture') return state;
      return { ...state, phase: 'recording', elapsedMs: 0, silentSoFar: true };

    case 'capture-failed':
      if (!isActivePhase(state.phase)) return state;
      return { ...state, phase: 'failed', error: action.error };

    case 'meter':
      if (state.phase !== 'recording') return state;
      return {
        ...state,
        level: { rms: action.rms, peak: action.peak },
        elapsedMs: action.elapsedMs,
        silentSoFar: state.silentSoFar && action.rms < 0.0015,
      };

    case 'stop-requested':
      if (state.phase !== 'recording') return state;
      return { ...state, phase: 'encoding', level: { rms: 0, peak: 0 } };

    case 'cancel-requested':
      if (!isActivePhase(state.phase)) return state;
      return { ...state, phase: 'cancelling' };

    case 'cancel-confirmed':
      if (action.sessionId !== state.sessionId) return state;
      return { ...state, phase: 'ready', error: null };

    case 'submitted':
      if (action.sessionId !== state.sessionId) return state;
      if (state.phase !== 'encoding') return state;
      return { ...state, phase: 'transcribing' };

    case 'regenerate':
      // Regeneration starts a fresh session; deltas from the previous
      // session ID are ignored from this point on.
      return {
        ...state,
        sessionId: action.sessionId,
        phase: 'generating',
        transcript: action.transcript,
        answer: '',
        lastSequence: -1,
        metrics: null,
        error: null,
      };

    case 'edit-transcript':
      if (isActivePhase(state.phase) && state.phase !== 'recording') {
        // Editing is only allowed once the pipeline is done with the clip.
        if (state.phase === 'transcribing' || state.phase === 'generating') return state;
      }
      return { ...state, transcript: action.text };

    case 'session-event':
      return applySessionEvent(state, action.event);

    case 'reset':
      return { ...initialCoachState, phase: 'ready' };

    default:
      return state;
  }
}

function applySessionEvent(state: CoachState, event: SessionEvent): CoachState {
  if (state.sessionId === null || event.sessionId !== state.sessionId) return state; // retired session
  switch (event.type) {
    case 'state': {
      // Cancelling is renderer-driven; only accept forward progress states.
      if (state.phase === 'cancelling' && event.state !== 'ready') return state;
      return { ...state, phase: event.state };
    }
    case 'transcript':
      return { ...state, transcript: event.text, transcriptLanguage: event.language };
    case 'answer-delta': {
      if (event.sequence <= state.lastSequence) return state; // out-of-order or duplicate
      if (state.phase !== 'generating' && state.phase !== 'transcribing') return state;
      return {
        ...state,
        phase: 'generating',
        answer: state.answer + event.text,
        lastSequence: event.sequence,
      };
    }
    case 'answer-complete':
      if (state.phase === 'cancelling') return state;
      return { ...state, phase: 'complete', answer: event.text, metrics: event.metrics };
    case 'progress':
      return state;
    case 'error':
      if (event.error.code === 'REQUEST_CANCELLED') {
        return { ...state, phase: 'ready', error: null };
      }
      return { ...state, phase: 'failed', error: event.error };
    default:
      return state;
  }
}
