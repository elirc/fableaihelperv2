import { describe, expect, it } from 'vitest';
import { publicError } from '../../src/shared/errors';
import {
  coachReducer,
  initialCoachState,
  type CoachAction,
  type CoachState,
} from '../../src/renderer/state/sessionMachine';

function run(actions: CoachAction[], from: CoachState = initialCoachState): CoachState {
  return actions.reduce(coachReducer, from);
}

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER = '11111111-2222-3333-4444-555555555555';

describe('coachReducer', () => {
  it('walks the happy path: arm -> record -> encode -> transcribe -> generate -> complete', () => {
    let state = run([
      { type: 'configured', ready: true },
      { type: 'arm', sessionId: SID },
      { type: 'capture-started' },
      { type: 'stop-requested' },
      { type: 'submitted', sessionId: SID },
      { type: 'session-event', event: { type: 'transcript', sessionId: SID, text: 'hello' } },
      { type: 'session-event', event: { type: 'state', sessionId: SID, state: 'generating' } },
      {
        type: 'session-event',
        event: { type: 'answer-delta', sessionId: SID, sequence: 0, text: 'Hi ' },
      },
      {
        type: 'session-event',
        event: { type: 'answer-delta', sessionId: SID, sequence: 1, text: 'there' },
      },
    ]);
    expect(state.transcript).toBe('hello');
    expect(state.answer).toBe('Hi there');
    state = coachReducer(state, {
      type: 'session-event',
      event: {
        type: 'answer-complete',
        sessionId: SID,
        text: 'Hi there',
        metrics: { totalMs: 1000 },
      },
    });
    expect(state.phase).toBe('complete');
    expect(state.metrics?.totalMs).toBe(1000);
  });

  it('ignores events from retired sessions', () => {
    const state = run([
      { type: 'arm', sessionId: SID },
      { type: 'capture-started' },
      { type: 'stop-requested' },
      { type: 'submitted', sessionId: SID },
      {
        type: 'session-event',
        event: { type: 'answer-delta', sessionId: OTHER, sequence: 0, text: 'stale' },
      },
    ]);
    expect(state.answer).toBe('');
  });

  it('ignores non-monotonic and duplicate answer sequences', () => {
    const state = run([
      { type: 'arm', sessionId: SID },
      { type: 'capture-started' },
      { type: 'stop-requested' },
      { type: 'submitted', sessionId: SID },
      {
        type: 'session-event',
        event: { type: 'answer-delta', sessionId: SID, sequence: 0, text: 'a' },
      },
      {
        type: 'session-event',
        event: { type: 'answer-delta', sessionId: SID, sequence: 0, text: 'dup' },
      },
      {
        type: 'session-event',
        event: { type: 'answer-delta', sessionId: SID, sequence: 2, text: 'b' },
      },
      {
        type: 'session-event',
        event: { type: 'answer-delta', sessionId: SID, sequence: 1, text: 'late' },
      },
    ]);
    expect(state.answer).toBe('ab');
  });

  it('does not restart recording from an invalid phase', () => {
    const state = run([{ type: 'capture-started' }]);
    expect(state.phase).toBe('checking');
  });

  it('routes errors to failed with the public error retained', () => {
    const err = publicError('PROVIDER_TIMEOUT');
    const state = run([
      { type: 'arm', sessionId: SID },
      { type: 'capture-started' },
      { type: 'stop-requested' },
      { type: 'submitted', sessionId: SID },
      { type: 'session-event', event: { type: 'error', sessionId: SID, error: err } },
    ]);
    expect(state.phase).toBe('failed');
    expect(state.error?.code).toBe('PROVIDER_TIMEOUT');
  });

  it('treats cancellation errors as a clean return to ready', () => {
    const state = run([
      { type: 'arm', sessionId: SID },
      { type: 'capture-started' },
      { type: 'stop-requested' },
      { type: 'submitted', sessionId: SID },
      {
        type: 'session-event',
        event: { type: 'error', sessionId: SID, error: publicError('REQUEST_CANCELLED') },
      },
    ]);
    expect(state.phase).toBe('ready');
    expect(state.error).toBeNull();
  });

  it('cancel flow: cancelling holds until confirmation, then ready', () => {
    let state = run([
      { type: 'arm', sessionId: SID },
      { type: 'capture-started' },
      { type: 'stop-requested' },
      { type: 'submitted', sessionId: SID },
      { type: 'cancel-requested' },
    ]);
    expect(state.phase).toBe('cancelling');
    // Late deltas during cancelling do not resurrect the stream.
    state = coachReducer(state, {
      type: 'session-event',
      event: { type: 'answer-delta', sessionId: SID, sequence: 0, text: 'late' },
    });
    expect(state.answer).toBe('');
    state = coachReducer(state, { type: 'cancel-confirmed', sessionId: SID });
    expect(state.phase).toBe('ready');
  });

  it('regenerate adopts a new session id and clears the previous answer', () => {
    let state = run([
      { type: 'arm', sessionId: SID },
      { type: 'capture-started' },
      { type: 'stop-requested' },
      { type: 'submitted', sessionId: SID },
      {
        type: 'session-event',
        event: { type: 'answer-delta', sessionId: SID, sequence: 0, text: 'old' },
      },
    ]);
    state = coachReducer(state, { type: 'regenerate', sessionId: OTHER, transcript: 'edited' });
    expect(state.answer).toBe('');
    expect(state.transcript).toBe('edited');
    // Old session deltas are now ignored.
    state = coachReducer(state, {
      type: 'session-event',
      event: { type: 'answer-delta', sessionId: SID, sequence: 1, text: 'stale' },
    });
    expect(state.answer).toBe('');
    state = coachReducer(state, {
      type: 'session-event',
      event: { type: 'answer-delta', sessionId: OTHER, sequence: 0, text: 'new' },
    });
    expect(state.answer).toBe('new');
  });

  it('meter updates track silence across the clip', () => {
    let state = run([
      { type: 'arm', sessionId: SID },
      { type: 'capture-started' },
      { type: 'meter', rms: 0.0001, peak: 0.001, elapsedMs: 100 },
    ]);
    expect(state.silentSoFar).toBe(true);
    state = coachReducer(state, { type: 'meter', rms: 0.2, peak: 0.4, elapsedMs: 200 });
    expect(state.silentSoFar).toBe(false);
  });

  it('edit-transcript works in the idle phases (practice draw and manual edits)', () => {
    // Ready: the practice deck writes a drawn question here.
    let state = run([
      { type: 'configured', ready: true },
      { type: 'edit-transcript', text: 'Tell me about yourself.' },
    ]);
    expect(state.transcript).toBe('Tell me about yourself.');
    // Complete: the user can rewrite the question and regenerate.
    state = run(
      [
        {
          type: 'session-event',
          event: { type: 'answer-complete', sessionId: SID, text: 'done', metrics: { totalMs: 1 } },
        },
        { type: 'edit-transcript', text: 'A follow-up question?' },
      ],
      { ...initialCoachState, sessionId: SID, phase: 'generating' },
    );
    expect(state.transcript).toBe('A follow-up question?');
  });

  it('edit-transcript is ignored while the pipeline owns the transcript', () => {
    for (const phase of ['transcribing', 'generating'] as const) {
      const state = coachReducer(
        { ...initialCoachState, sessionId: SID, phase, transcript: 'original' },
        { type: 'edit-transcript', text: 'overwrite attempt' },
      );
      expect(state.transcript).toBe('original');
    }
  });

  it('reset returns to ready and clears output', () => {
    const state = run([
      { type: 'arm', sessionId: SID },
      { type: 'capture-started' },
      { type: 'stop-requested' },
      { type: 'submitted', sessionId: SID },
      { type: 'session-event', event: { type: 'transcript', sessionId: SID, text: 'x' } },
      { type: 'reset' },
    ]);
    expect(state.phase).toBe('ready');
    expect(state.transcript).toBe('');
    expect(state.answer).toBe('');
  });
});
