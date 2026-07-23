import {
  ANSWER_CHAR_CAP,
  MIN_CLIP_SECONDS,
  SILENCE_RMS_THRESHOLD,
  TIMEOUTS,
} from '../../shared/constants';
import { decodeWavToFloat32, parseWavHeader, rms } from '../../shared/audio';
import type {
  Profile,
  SessionEvent,
  SessionMetrics,
  SessionOptions,
  SessionState,
} from '../../shared/domain';
import { CoachError, toPublicError } from '../../shared/errors';
import { buildPrompt } from '../../shared/prompt';
import { capText } from '../../shared/streaming';
import type { ProviderRegistry } from '../providers/registry';

export interface CoordinatorDeps {
  registry: ProviderRegistry;
  getSettings: () => Promise<{
    sttProviderId: string;
    sttModelId: string;
    sttLanguage: string;
    llmProviderId: string;
    llmModelId: string;
    historyEnabled: boolean;
    historyRetentionDays: number;
    maxClipSeconds: number;
    activeProfileId?: string;
  }>;
  getProfile: (id: string) => Promise<Profile | null>;
  saveHistory: (
    item: {
      transcript: string;
      answer: string;
      sttProviderId: string;
      sttModelId: string;
      llmProviderId: string;
      llmModelId: string;
      answerMode: string;
      timings: { encodeMs: number; transcribeMs: number; firstTokenMs?: number; totalMs: number };
    },
    retentionDays: number,
  ) => Promise<void>;
  emit: (event: SessionEvent) => void;
  recordError: (code: string, message: string) => void;
}

type CoordinatorSettings = Awaited<ReturnType<CoordinatorDeps['getSettings']>>;

interface SessionContext {
  id: string;
  controller: AbortController;
  state: SessionState;
  transcript?: string;
  answer: string;
  nextSequence: number;
  createdAt: number;
}

/**
 * Authoritative session lifecycle (spec §14). At most one active session;
 * starting a new one aborts and retires the old. Every event carries the
 * session ID; answer deltas carry a monotonic sequence number.
 */
export class SessionCoordinator {
  private active: SessionContext | null = null;

  constructor(private readonly deps: CoordinatorDeps) {}

  private retire(): void {
    if (this.active) {
      this.active.controller.abort();
      this.active = null;
    }
  }

  private begin(sessionId: string): SessionContext {
    this.retire();
    const context: SessionContext = {
      id: sessionId,
      controller: new AbortController(),
      state: 'transcribing',
      answer: '',
      nextSequence: 0,
      createdAt: Date.now(),
    };
    this.active = context;
    return context;
  }

  private isCurrent(context: SessionContext): boolean {
    return this.active === context && !context.controller.signal.aborted;
  }

  private emit(context: SessionContext, event: SessionEvent): void {
    if (this.isCurrent(context)) this.deps.emit(event);
  }

  private setState(context: SessionContext, state: SessionState): void {
    context.state = state;
    this.emit(context, { type: 'state', sessionId: context.id, state });
  }

  /**
   * Cancel the session if it is still the active one. Aborts all in-flight
   * provider work and emits a final 'ready' state (never an error), so the
   * renderer treats a cancel as a clean reset.
   */
  cancel(sessionId: string): void {
    if (this.active?.id === sessionId) {
      const context = this.active;
      context.controller.abort();
      this.active = null;
      this.deps.emit({ type: 'state', sessionId: context.id, state: 'ready' });
    }
  }

  /**
   * Best-effort LLM warmup with no session attached, fired when capture is
   * armed. Recording takes seconds; loading the model during them (instead
   * of during transcription) takes the cold start fully out of the
   * time-to-first-token path. Failures are swallowed — the real generate
   * call reports them with proper error mapping.
   */
  async prewarm(): Promise<void> {
    try {
      const settings = await this.deps.getSettings();
      const llm = this.deps.registry.getLlm(settings.llmProviderId);
      if (!llm.warmup) return;
      await llm
        .warmup(settings.llmModelId, AbortSignal.timeout(TIMEOUTS.warmup))
        .catch(() => undefined);
    } catch {
      // Unknown provider IDs fail the session later with a precise error.
    }
  }

  /** Full pipeline: validate WAV -> STT -> prompt -> streamed LLM. */
  async submit(
    sessionId: string,
    wav: Uint8Array,
    options: SessionOptions,
    encodeMs: number,
  ): Promise<void> {
    const context = this.begin(sessionId);
    const started = Date.now();
    try {
      const settings = await this.deps.getSettings();

      // Validate audio before any provider call (CAP-10, spec §13.3).
      const info = parseWavHeader(wav);
      if (info.durationMs < MIN_CLIP_SECONDS * 1000) {
        throw new CoachError('AUDIO_TOO_SHORT');
      }
      if (info.durationMs > (settings.maxClipSeconds + 5) * 1000) {
        throw new CoachError('AUDIO_TOO_LONG');
      }
      const { samples } = decodeWavToFloat32(wav);
      if (rms(samples) < SILENCE_RMS_THRESHOLD) {
        throw new CoachError('CAPTURE_SILENT');
      }

      this.setState(context, 'transcribing');
      this.warmupLlm(context, settings);
      const stt = this.deps.registry.getStt(settings.sttProviderId);
      const sttTimeout = stt.meta.location === 'local' ? TIMEOUTS.localStt : TIMEOUTS.cloudStt;
      const transcribeStarted = Date.now();
      const transcript = await stt.transcribe({
        audio: wav,
        mimeType: 'audio/wav',
        language: options.language ?? settings.sttLanguage,
        modelId: settings.sttModelId,
        signal: AbortSignal.any([context.controller.signal, AbortSignal.timeout(sttTimeout)]),
      });
      const transcribeMs = Date.now() - transcribeStarted;
      if (!this.isCurrent(context)) return;
      if (transcript.text.trim() === '') {
        throw new CoachError('TRANSCRIPT_EMPTY');
      }
      context.transcript = transcript.text;
      this.emit(context, {
        type: 'transcript',
        sessionId: context.id,
        text: transcript.text,
        language: transcript.language,
      });

      await this.generate(context, settings, transcript.text, options, {
        encodeMs,
        transcribeMs,
        startedAt: started,
        sttProviderId: settings.sttProviderId,
        sttModelId: settings.sttModelId,
      });
    } catch (err) {
      this.fail(context, err);
    }
  }

  /** Regenerate from an edited transcript without retranscribing (LLM-06). */
  async regenerate(sessionId: string, transcript: string, options: SessionOptions): Promise<void> {
    const context = this.begin(sessionId);
    try {
      const settings = await this.deps.getSettings();
      context.transcript = transcript;
      await this.generate(context, settings, transcript, options, {
        encodeMs: 0,
        transcribeMs: 0,
        startedAt: Date.now(),
      });
    } catch (err) {
      this.fail(context, err);
    }
  }

  /**
   * Fire-and-forget LLM warmup, run while transcription is still in flight
   * (local model load / cloud TLS setup overlaps STT instead of adding to
   * first-token latency). Best-effort by contract: any failure surfaces
   * later through the real generate call, with its proper error mapping.
   */
  private warmupLlm(context: SessionContext, settings: CoordinatorSettings): void {
    try {
      const llm = this.deps.registry.getLlm(settings.llmProviderId);
      if (!llm.warmup) return;
      const signal = AbortSignal.any([
        context.controller.signal,
        AbortSignal.timeout(TIMEOUTS.warmup),
      ]);
      void llm.warmup(settings.llmModelId, signal).catch(() => undefined);
    } catch {
      // Unknown provider IDs fail the session later with a precise error.
    }
  }

  private async generate(
    context: SessionContext,
    settings: CoordinatorSettings,
    transcript: string,
    options: SessionOptions,
    timing: {
      encodeMs: number;
      transcribeMs: number;
      startedAt: number;
      sttProviderId?: string;
      sttModelId?: string;
    },
  ): Promise<void> {
    const llm = this.deps.registry.getLlm(settings.llmProviderId);
    const profile = settings.activeProfileId
      ? await this.deps.getProfile(settings.activeProfileId)
      : null;

    this.setState(context, 'generating');
    const prompt = buildPrompt({
      profile,
      sessionNotes: options.sessionNotes,
      transcript,
      answerMode: options.answerMode,
      targetSeconds: options.targetSeconds,
    });

    // First-token timeout applies until the first delta arrives; the total
    // timeout covers the whole stream.
    const firstTokenTimeout = new AbortController();
    const timer = setTimeout(() => firstTokenTimeout.abort(), TIMEOUTS.llmFirstToken);
    const signal = AbortSignal.any([
      context.controller.signal,
      AbortSignal.timeout(TIMEOUTS.llmTotal),
      firstTokenTimeout.signal,
    ]);

    let firstTokenMs: number | undefined;
    let sawFirst = false;
    try {
      for await (const delta of llm.generate({
        system: prompt.system,
        user: prompt.user,
        modelId: settings.llmModelId,
        signal,
      })) {
        if (!this.isCurrent(context)) return;
        if (!sawFirst) {
          sawFirst = true;
          clearTimeout(timer);
          firstTokenMs = Date.now() - timing.startedAt;
        }
        if (context.answer.length >= ANSWER_CHAR_CAP) break;
        context.answer += delta.text;
        this.emit(context, {
          type: 'answer-delta',
          sessionId: context.id,
          sequence: context.nextSequence++,
          text: delta.text,
        });
      }
    } catch (err) {
      if (firstTokenTimeout.signal.aborted && !context.controller.signal.aborted && !sawFirst) {
        throw new CoachError('PROVIDER_TIMEOUT', 'no response from the model in time');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!this.isCurrent(context)) return;

    const answer = capText(context.answer, ANSWER_CHAR_CAP);
    const metrics: SessionMetrics = {
      encodeMs: timing.encodeMs,
      transcribeMs: timing.transcribeMs,
      firstTokenMs,
      totalMs: Date.now() - timing.startedAt,
      sttProviderId: timing.sttProviderId,
      sttModelId: timing.sttModelId,
      llmProviderId: settings.llmProviderId,
      llmModelId: settings.llmModelId,
    };
    this.setState(context, 'complete');
    this.emit(context, { type: 'answer-complete', sessionId: context.id, text: answer, metrics });
    // The session is finished: retire it before the best-effort history write
    // so a cancel() arriving during the disk write cannot match it and emit a
    // spurious 'ready' after 'answer-complete'.
    if (this.active === context) this.active = null;

    if (settings.historyEnabled) {
      await this.deps
        .saveHistory(
          {
            transcript,
            answer,
            sttProviderId: timing.sttProviderId ?? '',
            sttModelId: timing.sttModelId ?? '',
            llmProviderId: settings.llmProviderId,
            llmModelId: settings.llmModelId,
            answerMode: options.answerMode,
            timings: {
              encodeMs: timing.encodeMs,
              transcribeMs: timing.transcribeMs,
              firstTokenMs,
              totalMs: metrics.totalMs,
            },
          },
          settings.historyRetentionDays,
        )
        .catch(() => undefined); // history failure must not fail the session
    }
  }

  private fail(context: SessionContext, err: unknown): void {
    const publicErr = toPublicError(err);
    // Deliberate aborts (cancel, or retirement by a newer session) are not
    // failures; recording them would evict real errors from diagnostics.
    if (!context.controller.signal.aborted) {
      this.deps.recordError(publicErr.code, publicErr.message);
    }
    if (this.active === context) {
      this.active = null;
      if (!context.controller.signal.aborted) {
        this.deps.emit({ type: 'error', sessionId: context.id, error: publicErr });
      }
    }
  }
}
