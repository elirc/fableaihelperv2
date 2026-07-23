import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { answerStats } from '../../shared/answerStats';
import type { AnswerMode, PublicError, PublicSettings, TargetSeconds } from '../../shared/domain';
import { SilenceEndpointer } from '../../shared/endpointing';
import { publicError } from '../../shared/errors';
import { PRACTICE_CATEGORIES, PracticeDeck, type PracticeCategory } from '../../shared/practice';
import { ClipRecorder } from '../audio/recorder';
import { resolveShortcut } from '../state/shortcuts';
import { coachReducer, initialCoachState, isActivePhase } from '../state/sessionMachine';

interface Props {
  settings: PublicSettings;
  onSettingsChanged: () => Promise<void>;
}

const PHASE_LABEL: Record<string, string> = {
  unconfigured: 'Setup needed',
  checking: 'Checking…',
  ready: 'Ready',
  arming_capture: 'Starting…',
  recording: 'Recording',
  encoding: 'Encoding…',
  transcribing: 'Transcribing…',
  generating: 'Generating…',
  complete: 'Done',
  cancelling: 'Cancelling…',
  failed: 'Failed',
};

function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function Coach({ settings, onSettingsChanged }: Props): React.JSX.Element {
  const [state, dispatch] = useReducer(coachReducer, initialCoachState);
  const recorderRef = useRef<ClipRecorder | null>(null);
  const sessionRef = useRef<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [liveMessage, setLiveMessage] = useState('');
  const [notes, setNotes] = useState('');
  const notesRef = useRef('');
  const [practiceCategory, setPracticeCategory] = useState<PracticeCategory | 'all'>('all');
  const deckRef = useRef<PracticeDeck | null>(null);
  const [dealtCount, setDealtCount] = useState(0);
  const optionsRef = useRef<{ answerMode: AnswerMode; targetSeconds: TargetSeconds }>({
    answerMode: settings.answerMode,
    targetSeconds: settings.targetSeconds,
  });

  useEffect(() => {
    optionsRef.current = { answerMode: settings.answerMode, targetSeconds: settings.targetSeconds };
  }, [settings.answerMode, settings.targetSeconds]);

  useEffect(() => {
    // Ref mirror so callbacks captured at record start see current notes.
    notesRef.current = notes;
  }, [notes]);

  const sessionNotesOption = () => {
    const trimmed = notesRef.current.trim();
    return trimmed === '' ? undefined : trimmed;
  };

  useEffect(() => {
    dispatch({ type: 'configured', ready: settings.onboardingComplete });
  }, [settings.onboardingComplete]);

  useEffect(() => {
    return window.cuedeck.onSessionEvent((event) => {
      dispatch({ type: 'session-event', event });
      if (event.type === 'answer-complete') setLiveMessage('Response ready.');
      if (event.type === 'error') setLiveMessage(event.error.message);
    });
  }, []);

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    const sessionId = sessionRef.current;
    if (!recorder || !sessionId) return;
    recorderRef.current = null;
    dispatch({ type: 'stop-requested' });
    try {
      const clip = await recorder.stop();
      await window.cuedeck.submitSession(
        sessionId,
        clip.wav,
        {
          ...optionsRef.current,
          language: settings.sttLanguage,
          sessionNotes: sessionNotesOption(),
        },
        clip.encodeMs,
      );
      dispatch({ type: 'submitted', sessionId });
    } catch (err) {
      dispatch({ type: 'capture-failed', error: asPublicError(err) });
    }
  }, [settings.sttLanguage]);

  const startRecording = useCallback(async () => {
    const sessionId = crypto.randomUUID();
    sessionRef.current = sessionId;
    dispatch({ type: 'arm', sessionId });
    const endpointer = settings.autoStopOnSilence ? new SilenceEndpointer() : null;
    const recorder = new ClipRecorder(settings.maxClipSeconds, {
      onLevel: (rms, peak, elapsedMs) => {
        dispatch({ type: 'meter', rms, peak, elapsedMs });
        if (endpointer?.push(rms, elapsedMs)) {
          setLiveMessage('Pause detected — responding.');
          void stopRecording();
        }
      },
      onAutoStop: () => void stopRecording(),
    });
    recorderRef.current = recorder;
    try {
      await window.cuedeck.armCapture(sessionId);
      await recorder.start();
      dispatch({ type: 'capture-started' });
      setLiveMessage('Recording started.');
    } catch (err) {
      recorderRef.current = null;
      await recorder.abort();
      dispatch({ type: 'capture-failed', error: asCaptureError(err) });
    }
  }, [settings.maxClipSeconds, settings.autoStopOnSilence, stopRecording]);

  const cancel = useCallback(async () => {
    const sessionId = sessionRef.current;
    dispatch({ type: 'cancel-requested' });
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) await recorder.abort();
    if (sessionId) {
      await window.cuedeck.cancelSession(sessionId).catch(() => undefined);
      dispatch({ type: 'cancel-confirmed', sessionId });
    }
    setLiveMessage('Cancelled.');
  }, []);

  const regenerate = useCallback(
    async (overrides: Partial<{ answerMode: AnswerMode; targetSeconds: TargetSeconds }> = {}) => {
      if (!state.transcript.trim()) return;
      const sessionId = crypto.randomUUID();
      sessionRef.current = sessionId;
      const options = { ...optionsRef.current, ...overrides, sessionNotes: sessionNotesOption() };
      dispatch({ type: 'regenerate', sessionId, transcript: state.transcript });
      await window.cuedeck.regenerate(sessionId, state.transcript, options).catch((err) => {
        dispatch({ type: 'capture-failed', error: asPublicError(err) });
      });
    },
    [state.transcript],
  );

  const copyAnswer = useCallback(async () => {
    await navigator.clipboard.writeText(state.answer);
    setCopied(true);
    setLiveMessage('Response copied to clipboard.');
    window.setTimeout(() => setCopied(false), 2000);
  }, [state.answer]);

  useEffect(() => {
    // Ctrl+L listen/stop, Esc cancel, Ctrl+Shift+C copy (see shortcuts.ts).
    const onKeyDown = (event: KeyboardEvent) => {
      const action = resolveShortcut(event, state.phase);
      if (!action) return;
      event.preventDefault();
      if (action === 'start-listening') void startRecording();
      else if (action === 'stop-listening') void stopRecording();
      else if (action === 'cancel') void cancel();
      else if (action === 'copy-answer' && state.answer) void copyAnswer();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [state.phase, state.answer, startRecording, stopRecording, cancel, copyAnswer]);

  const setMode = async (answerMode: AnswerMode) => {
    await window.cuedeck.updatePublicSettings({ answerMode });
    await onSettingsChanged();
  };

  const toggleCompact = async () => {
    await window.cuedeck.updatePublicSettings({ compactMode: !settings.compactMode });
    await onSettingsChanged();
  };

  const setAutoStop = async (autoStopOnSilence: boolean) => {
    await window.cuedeck.updatePublicSettings({ autoStopOnSilence });
    await onSettingsChanged();
  };

  const drawPracticeQuestion = () => {
    if (!deckRef.current) deckRef.current = new PracticeDeck(practiceCategory);
    const deck = deckRef.current;
    const question = deck.draw();
    dispatch({ type: 'edit-transcript', text: question.text });
    setDealtCount(deck.size - deck.remaining);
    setLiveMessage('Practice question ready.');
  };

  const changePracticeCategory = (category: PracticeCategory | 'all') => {
    setPracticeCategory(category);
    deckRef.current = null;
    setDealtCount(0);
  };

  const isRecording = state.phase === 'recording';
  const busy = isActivePhase(state.phase) || state.phase === 'cancelling';
  const localMode =
    settings.sttProviderId === 'local-whisper' && settings.llmProviderId === 'ollama';
  const compact = settings.compactMode;
  const showSilenceWarning = isRecording && state.silentSoFar && state.elapsedMs > 3000;
  const stats =
    state.phase === 'complete' ? answerStats(state.answer, settings.targetSeconds) : null;

  return (
    <div className={`app-shell${compact ? ' compact' : ''}`}>
      <header className="titlebar">
        <span className="brand">CueDeck</span>
        <span
          className={`status-chip ${state.phase === 'ready' || state.phase === 'complete' ? 'ready' : state.phase === 'failed' ? 'error' : ''}`}
          data-testid="phase-chip"
        >
          {localMode ? 'Local' : 'Cloud'} • {PHASE_LABEL[state.phase] ?? state.phase}
        </span>
        {isRecording && (
          <span className="recording-indicator" data-testid="recording-indicator" role="status">
            <span className="dot" aria-hidden="true" /> Recording
          </span>
        )}
        <span className="spacer" />
        <button className="small" onClick={() => void toggleCompact()}>
          {compact ? 'Expand' : 'Compact'}
        </button>
        <button
          className="small"
          onClick={() => void window.cuedeck.openPreferences()}
          data-testid="open-preferences"
        >
          Settings
        </button>
      </header>

      <main className="coach-body">
        <section className="card">
          <div className="capture-row">
            {!isRecording ? (
              <button
                className="primary"
                onClick={() => void startRecording()}
                disabled={busy || state.phase === 'unconfigured'}
                data-testid="listen-button"
                title="Ctrl+L"
              >
                Listen
              </button>
            ) : (
              <button
                className="primary"
                onClick={() => void stopRecording()}
                data-testid="stop-button"
                title="Ctrl+L"
              >
                Stop &amp; respond
              </button>
            )}
            {busy && (
              <button onClick={() => void cancel()} data-testid="cancel-button" title="Esc">
                Cancel
              </button>
            )}
            <span className="timer" aria-label="elapsed recording time">
              {formatTime(state.elapsedMs)}
            </span>
            <div className="meter" role="img" aria-label="audio input level">
              <div style={{ width: `${Math.min(100, state.level.rms * 700)}%` }} />
            </div>
          </div>
          <label className="row auto-stop">
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={settings.autoStopOnSilence}
              onChange={(e) => void setAutoStop(e.target.checked)}
              data-testid="auto-stop-toggle"
            />
            <span>Auto-respond when the speaker pauses</span>
          </label>
          {showSilenceWarning && (
            <p className="warn-banner" role="alert">
              No audio detected yet — check that the conversation audio is playing on this computer.
            </p>
          )}
        </section>

        {!compact && (
          <section className="card">
            <h2>
              Practice
              {dealtCount > 0 && deckRef.current && (
                <span className="deck-progress" data-testid="practice-progress">
                  {dealtCount} of {deckRef.current.size}
                </span>
              )}
            </h2>
            <div className="row">
              <select
                aria-label="practice category"
                value={practiceCategory}
                onChange={(e) => changePracticeCategory(e.target.value as PracticeCategory | 'all')}
                data-testid="practice-category"
                style={{ maxWidth: 220 }}
              >
                {PRACTICE_CATEGORIES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
              <button
                className="small"
                onClick={drawPracticeQuestion}
                disabled={busy}
                data-testid="practice-draw"
              >
                Draw a question
              </button>
            </div>
            <p className="hint">
              The question lands in “Heard” below — answer it aloud first, then press “Respond to
              edited text” to compare with a suggested response.
            </p>
          </section>
        )}

        {state.error && (
          <div className="error-banner" role="alert" data-testid="error-banner">
            <span>{state.error.message}</span>
            {state.error.action === 'open-diagnostics' && (
              <button className="small" onClick={() => void window.cuedeck.openPreferences()}>
                Open diagnostics
              </button>
            )}
            {state.error.retryable && (
              <button className="small" onClick={() => dispatch({ type: 'reset' })}>
                Dismiss
              </button>
            )}
          </div>
        )}

        {!compact && (
          <section className="card">
            <h2>
              Heard
              <span className="actions">
                <button
                  className="small"
                  onClick={() => void regenerate()}
                  disabled={!state.transcript.trim() || busy}
                  data-testid="regenerate-button"
                >
                  Respond to edited text
                </button>
              </span>
            </h2>
            <textarea
              aria-label="transcript (editable)"
              value={state.transcript}
              onChange={(e) => dispatch({ type: 'edit-transcript', text: e.target.value })}
              disabled={state.phase === 'transcribing' || state.phase === 'generating'}
              data-testid="transcript-input"
            />
          </section>
        )}

        <section className="card">
          <h2>
            Response
            <span className="actions">
              <button
                className="small"
                onClick={() => void copyAnswer()}
                disabled={!state.answer}
                data-testid="copy-button"
                title="Ctrl+Shift+C"
              >
                {copied ? 'Copied ✓' : 'Copy'}
              </button>
              <button
                className="small"
                onClick={() => dispatch({ type: 'reset' })}
                disabled={!state.answer && !state.transcript}
                data-testid="clear-button"
              >
                Clear
              </button>
            </span>
          </h2>
          <div className="answer-text" data-testid="answer-text">
            {state.answer}
            {state.phase === 'generating' && <span className="caret">&nbsp;</span>}
          </div>
          {stats && (
            <p className="answer-stats" data-testid="answer-stats">
              ~{stats.seconds} s spoken ({stats.words} words) —{' '}
              {stats.verdict === 'on-target'
                ? `about right for your ${settings.targetSeconds} s target`
                : stats.verdict === 'long'
                  ? `longer than your ${settings.targetSeconds} s target`
                  : `shorter than your ${settings.targetSeconds} s target`}
            </p>
          )}
          <div className="mode-row" role="group" aria-label="response follow-ups">
            <button
              className="small"
              disabled={!state.transcript || busy}
              onClick={() => void regenerate({ targetSeconds: 15 })}
            >
              Shorter
            </button>
            <button
              className="small"
              disabled={!state.transcript || busy}
              onClick={() => void regenerate({ answerMode: 'bullets' })}
            >
              Bullets
            </button>
            <button
              className="small"
              disabled={!state.transcript || busy}
              onClick={() => void regenerate({ answerMode: 'star' })}
            >
              STAR
            </button>
            <button
              className="small"
              disabled={!state.transcript || busy}
              onClick={() => void regenerate({ answerMode: 'concise' })}
            >
              More concise
            </button>
            <button
              className="small"
              disabled={!state.transcript || busy}
              onClick={() => void regenerate()}
              data-testid="try-again-button"
            >
              Try again
            </button>
          </div>
        </section>

        {!compact && (
          <section className="card">
            <h2>
              Session notes
              <span className="actions">
                {notes !== '' && (
                  <button className="small" onClick={() => setNotes('')} data-testid="notes-clear">
                    Clear
                  </button>
                )}
              </span>
            </h2>
            <textarea
              aria-label="session notes"
              rows={2}
              maxLength={4000}
              placeholder="Optional context for this call — company, role, points to hit. Sent with every response request."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              data-testid="session-notes-input"
            />
          </section>
        )}

        {!compact && (
          <section className="card">
            <h2>Default mode</h2>
            <div className="mode-row" role="group" aria-label="answer mode">
              {(['natural', 'concise', 'bullets', 'star', 'clarify'] as AnswerMode[]).map(
                (mode) => (
                  <button
                    key={mode}
                    className="small"
                    aria-pressed={settings.answerMode === mode}
                    style={
                      settings.answerMode === mode
                        ? { borderColor: 'var(--accent)', color: 'var(--accent)' }
                        : undefined
                    }
                    onClick={() => void setMode(mode)}
                  >
                    {mode === 'star' ? 'STAR' : mode[0].toUpperCase() + mode.slice(1)}
                  </button>
                ),
              )}
            </div>
          </section>
        )}
      </main>

      <footer className="status-rail" data-testid="status-rail">
        <span>
          {settings.sttProviderId === 'local-whisper' ? 'Local Whisper' : settings.sttProviderId} (
          {settings.sttModelId.split('/').pop()})
        </span>
        <span>•</span>
        <span>
          {settings.llmModelId || 'no model'} via {settings.llmProviderId}
        </span>
        {state.metrics && (
          <>
            <span>•</span>
            <span>{(state.metrics.totalMs / 1000).toFixed(1)} s total</span>
            {state.metrics.transcribeMs !== undefined && state.metrics.transcribeMs > 0 && (
              <span>({(state.metrics.transcribeMs / 1000).toFixed(1)} s transcribe)</span>
            )}
            {state.metrics.firstTokenMs !== undefined && (
              <span>({(state.metrics.firstTokenMs / 1000).toFixed(1)} s to first words)</span>
            )}
          </>
        )}
      </footer>
      <div aria-live="polite" className="visually-hidden">
        {liveMessage}
      </div>
    </div>
  );
}

function asPublicError(err: unknown): PublicError {
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    return err as PublicError;
  }
  return publicError('UNKNOWN', err instanceof Error ? err.message : undefined);
}

function asCaptureError(err: unknown): PublicError {
  if (err instanceof Error) {
    if (err.message === 'CAPTURE_NO_AUDIO') return publicError('CAPTURE_NO_AUDIO');
    if (err.name === 'NotAllowedError' || err.name === 'AbortError')
      return publicError('CAPTURE_DENIED');
  }
  return asPublicError(err);
}
