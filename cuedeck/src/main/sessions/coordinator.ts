import {
  ANSWER_CHAR_CAP,
  BACKUP_FIRST_TOKEN_TIMEOUT_MS,
  CONVERSATION_EXCHANGES,
  MIN_CLIP_SECONDS,
  SILENCE_RMS_THRESHOLD,
  TARGET_SAMPLE_RATE,
  TIMEOUTS,
} from '../../shared/constants';
import {
  decodeWavToFloat32,
  encodeWav,
  hasSound,
  parseWavHeader,
  resample,
  rms,
  trimSilence,
} from '../../shared/audio';
import type {
  AnswerMode,
  ConversationExchange,
  FollowUpOptions,
  Profile,
  SessionEvent,
  SessionMetrics,
  SessionOptions,
  SessionState,
  TargetSeconds,
  TranscriptResult,
} from '../../shared/domain';
import { CoachError, toPublicError } from '../../shared/errors';
import {
  answerTemperature,
  answerTokenBudget,
  buildInterviewerPrompt,
  buildPrompt,
  buildPromptPrefix,
  INTERVIEWER_MAX_TOKENS,
  INTERVIEWER_TEMPERATURE,
  type BuiltPrompt,
} from '../../shared/prompt';
import { capText } from '../../shared/streaming';
import type { SttProvider, WarmupPrefix } from '../providers/contracts';
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
    /** Default answer shape; used to pre-fill the prompt cache before a session exists. */
    answerMode?: AnswerMode;
    targetSeconds?: TargetSeconds;
    /** Send earlier exchanges as context (default on). */
    conversationMemory?: boolean;
    /** Explicit backup response model; empty/undefined = none. */
    llmBackupProviderId?: string;
    llmBackupModelId?: string;
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
 * One speculative transcription of a clip-so-far snapshot. `frames` is the
 * 16 kHz sample count the snapshot covered; the final clip reuses the
 * result only if nothing but silence follows that point.
 */
interface SpeculationJob {
  sessionId: string;
  frames: number;
  /** Local inference: aborting kills the worker and forces a model reload. */
  local: boolean;
  controller: AbortController;
  promise: Promise<TranscriptResult>;
  settled: boolean;
}

interface PendingSnapshot {
  sessionId: string;
  wav: Uint8Array;
  language?: string;
}

/** Decoded, silence-trimmed audio ready for a provider. */
interface PreparedAudio {
  wav: Uint8Array;
  samples: Float32Array;
}

interface LlmTarget {
  providerId: string;
  modelId: string;
}

interface Sampling {
  temperature: number;
  maxTokens: number;
}

/** Outcome of one streamed generation (primary or backup). */
interface StreamOutcome extends LlmTarget {
  usedBackup: boolean;
  firstTokenAt?: number;
}

/** Longest interviewer question accepted from the model (characters). */
const FOLLOW_UP_CHAR_CAP = 600;

/**
 * Authoritative session lifecycle (spec §14). At most one active session;
 * starting a new one aborts and retires the old. Every event carries the
 * session ID; answer deltas carry a monotonic sequence number.
 *
 * Latency machinery, all best-effort and invisible when it fails:
 * - `prewarm` (capture armed / app start) loads the local STT model and
 *   pre-fills the LLM's prompt cache with the system prompt + profile.
 * - `speculate` (silence onset, ~0.7 s into a pause) transcribes the clip
 *   so far; if the pause turns out to be the end of the question, `submit`
 *   reuses that transcript and skips the STT stage entirely.
 */
export class SessionCoordinator {
  private active: SessionContext | null = null;
  /** Latest speculative job (running or finished) that a submit may reuse. */
  private speculation: SpeculationJob | null = null;
  /** In-flight speculative job, when one is still running. */
  private speculationInflight: SpeculationJob | null = null;
  /** Newest snapshot waiting for the in-flight local job to finish. */
  private speculationPending: PendingSnapshot | null = null;
  /** The most recent LLM warmup, so identical back-to-back warmups coalesce. */
  private lastWarmup: { key: string; promise: Promise<void>; settled: boolean } | null = null;
  /**
   * The last few question/answer pairs, oldest first. Sent with every
   * request (when enabled) so follow-up questions are answered in context,
   * and used to generate the interviewer's next question. Lives only in
   * memory: cleared by the user, never persisted.
   */
  private conversation: ConversationExchange[] = [];

  constructor(private readonly deps: CoordinatorDeps) {}

  private retire(): void {
    if (this.active) {
      this.active.controller.abort();
      this.active = null;
    }
  }

  private begin(sessionId: string): SessionContext {
    this.retire();
    // Snapshots from any other session can never match this clip.
    if (this.speculation && this.speculation.sessionId !== sessionId) this.discardSpeculation();
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
    if (this.speculation?.sessionId === sessionId) this.discardSpeculation({ force: true });
    if (this.active?.id === sessionId) {
      const context = this.active;
      context.controller.abort();
      this.active = null;
      this.deps.emit({ type: 'state', sessionId: context.id, state: 'ready' });
    }
  }

  /**
   * Best-effort STT + LLM warmup with no session attached, fired when
   * capture is armed (and once at app start). Recording takes seconds;
   * loading both models during them — and pre-filling the LLM's prompt
   * cache with the stable part of the prompt — takes the cold starts fully
   * out of the time-to-first-token path. Failures are swallowed; the real
   * transcribe/generate calls report them with proper error mapping.
   */
  async prewarm(): Promise<void> {
    let settings: CoordinatorSettings;
    try {
      settings = await this.deps.getSettings();
    } catch {
      return;
    }
    const jobs: Promise<unknown>[] = [];
    try {
      const stt = this.deps.registry.getStt(settings.sttProviderId);
      if (stt.warmup) {
        // A transcribe that arrives mid-load joins this load, so its timeout
        // must be at least as patient as the transcribe stage itself.
        const timeout = stt.meta.location === 'local' ? TIMEOUTS.localStt : TIMEOUTS.warmup;
        jobs.push(
          stt.warmup(settings.sttModelId, AbortSignal.timeout(timeout)).catch(() => undefined),
        );
      }
    } catch {
      // Unknown provider IDs fail the session later with a precise error.
    }
    const profile = await this.loadProfile(settings);
    const prefix =
      settings.answerMode && settings.targetSeconds
        ? buildPromptPrefix({
            profile,
            answerMode: settings.answerMode,
            targetSeconds: settings.targetSeconds,
          })
        : undefined;
    jobs.push(this.warmupLlm(settings, AbortSignal.timeout(TIMEOUTS.warmup), prefix));
    await Promise.all(jobs);
  }

  /**
   * Start transcribing a snapshot of the clip so far. Called by the
   * renderer at silence onset, well before the endpointer fires, so the
   * trailing-silence wait overlaps transcription instead of preceding it.
   * Never emits: the result is consumed by `submit`, or thrown away.
   *
   * Superseding rules keep cost bounded. A cloud request that is no longer
   * the newest snapshot is aborted (it costs quota while it runs). A local
   * inference cannot be interrupted without killing the worker and
   * reloading the model, so it runs to completion and the newest snapshot
   * waits behind it — at most one in flight and one pending.
   */
  async speculate(sessionId: string, wav: Uint8Array, language?: string): Promise<void> {
    let settings: CoordinatorSettings;
    let stt: SttProvider;
    try {
      settings = await this.deps.getSettings();
      stt = this.deps.registry.getStt(settings.sttProviderId);
      if (parseWavHeader(wav).durationMs < MIN_CLIP_SECONDS * 1000) return;
    } catch {
      return;
    }
    this.speculationPending = null;
    const inflight = this.speculationInflight;
    if (inflight) {
      if (inflight.sessionId === sessionId && stt.meta.location === 'local') {
        this.speculationPending = { sessionId, wav, language };
        return;
      }
      inflight.controller.abort();
      this.speculationInflight = null;
    }
    this.startSpeculation(sessionId, wav, language, settings, stt);
  }

  private startSpeculation(
    sessionId: string,
    wav: Uint8Array,
    language: string | undefined,
    settings: CoordinatorSettings,
    stt: SttProvider,
  ): void {
    const controller = new AbortController();
    const sttTimeout = stt.meta.location === 'local' ? TIMEOUTS.localStt : TIMEOUTS.cloudStt;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(sttTimeout)]);
    const job: SpeculationJob = {
      sessionId,
      frames: 0,
      local: stt.meta.location === 'local',
      controller,
      settled: false,
      promise: Promise.resolve({ text: '' }),
    };
    job.promise = (async () => {
      const { samples } = decodeWavToFloat32(wav);
      job.frames = samples.length;
      return this.transcribe(stt, this.prepareAudio(wav, samples), language, settings, signal);
    })().finally(() => {
      job.settled = true;
      if (this.speculationInflight === job) {
        this.speculationInflight = null;
        const next = this.speculationPending;
        this.speculationPending = null;
        if (next) void this.speculate(next.sessionId, next.wav, next.language);
      }
    });
    // Nobody may ever await this job (speech resumed, session cancelled);
    // the rejection must not surface as an unhandled promise.
    job.promise.catch(() => undefined);
    this.speculationInflight = job;
    this.speculation = job;
  }

  /**
   * Hand back the speculative job for this clip if its transcript is still
   * valid: the clip must extend the snapshot with nothing but silence. Any
   * other job is discarded.
   */
  private takeSpeculation(sessionId: string, samples: Float32Array): SpeculationJob | null {
    const job = this.speculation;
    this.speculation = null;
    this.speculationPending = null;
    if (!job) return null;
    const reusable =
      job.sessionId === sessionId &&
      !job.controller.signal.aborted &&
      job.frames > 0 &&
      samples.length >= job.frames &&
      !hasSound(samples.subarray(job.frames), TARGET_SAMPLE_RATE);
    if (reusable) return job;
    this.discardJob(job);
    return null;
  }

  private discardSpeculation(options: { force?: boolean } = {}): void {
    const job = this.speculation;
    this.speculation = null;
    this.speculationPending = null;
    if (job) this.discardJob(job, options);
  }

  /**
   * Abort a job whose result is no longer wanted — unless it is a local
   * inference (killing the worker costs a model reload on the next turn)
   * and the caller did not insist.
   */
  private discardJob(job: SpeculationJob, options: { force?: boolean } = {}): void {
    if (job.settled) return;
    if (options.force || !job.local) {
      job.controller.abort();
      if (this.speculationInflight === job) this.speculationInflight = null;
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
      // The profile is needed for the prompt anyway; reading it now (off
      // the critical path) also lets the warmup carry the real prefix.
      const profile = await this.loadProfile(settings);
      void this.warmupLlm(
        settings,
        AbortSignal.any([context.controller.signal, AbortSignal.timeout(TIMEOUTS.warmup)]),
        buildPromptPrefix({
          profile,
          answerMode: options.answerMode,
          targetSeconds: options.targetSeconds,
        }),
      );
      const stt = this.deps.registry.getStt(settings.sttProviderId);
      const transcribeStarted = Date.now();
      const language = options.language ?? settings.sttLanguage;

      let transcript: TranscriptResult | null = null;
      let speculative = false;
      const job = this.takeSpeculation(sessionId, samples);
      if (job) {
        try {
          transcript = await abortable(job.promise, context.controller.signal);
          speculative = true;
        } catch {
          // A failed or cancelled speculation is not a failed session; fall
          // through to a regular pass (which reports real errors properly).
          if (context.controller.signal.aborted) return;
        }
      }
      if (!transcript) {
        const sttTimeout = stt.meta.location === 'local' ? TIMEOUTS.localStt : TIMEOUTS.cloudStt;
        transcript = await this.transcribe(
          stt,
          this.prepareAudio(wav, samples),
          language,
          settings,
          AbortSignal.any([context.controller.signal, AbortSignal.timeout(sttTimeout)]),
        );
      }
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

      await this.generate(context, settings, profile, transcript.text, options, {
        encodeMs,
        transcribeMs,
        sttSpeculative: speculative,
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
      const profile = await this.loadProfile(settings);
      context.transcript = transcript;
      await this.generate(context, settings, profile, transcript, options, {
        encodeMs: 0,
        transcribeMs: 0,
        startedAt: Date.now(),
      });
    } catch (err) {
      this.fail(context, err);
    }
  }

  /**
   * Generate the interviewer's next question from the conversation so far
   * and deliver it as a 'follow-up' event (it lands in the transcript box,
   * ready to be answered). Uses the same provider, backup, and fencing as
   * answers; the question itself is not recorded as an exchange — the
   * answer to it will be.
   */
  async followUp(sessionId: string, options: FollowUpOptions): Promise<void> {
    const context = this.begin(sessionId);
    try {
      const settings = await this.deps.getSettings();
      if (this.conversation.length === 0) {
        throw new CoachError('TRANSCRIPT_EMPTY', 'no exchange to follow up on yet');
      }
      const profile = await this.loadProfile(settings);
      this.setState(context, 'generating');
      const prompt = buildInterviewerPrompt({
        profile,
        sessionNotes: options.sessionNotes,
        exchanges: this.conversation,
      });
      let text = '';
      const outcome = await this.streamWithBackup(
        context,
        settings,
        prompt,
        { temperature: INTERVIEWER_TEMPERATURE, maxTokens: INTERVIEWER_MAX_TOKENS },
        (delta) => {
          text += delta;
        },
        FOLLOW_UP_CHAR_CAP,
      );
      if (!outcome || !this.isCurrent(context)) return;
      const question = cleanQuestion(text);
      if (question === '') {
        throw new CoachError('PROVIDER_UNAVAILABLE', 'the model returned no question');
      }
      this.emit(context, { type: 'follow-up', sessionId: context.id, text: question });
      this.setState(context, 'ready');
      if (this.active === context) this.active = null;
    } catch (err) {
      this.fail(context, err);
    }
  }

  /** Forget the remembered exchanges: the next question starts a new conversation. */
  clearConversation(): void {
    this.conversation = [];
  }

  /**
   * Remember a finished exchange. Regenerating the same question ("Try
   * again", "Shorter") replaces the previous answer instead of adding a
   * duplicate turn.
   */
  private recordExchange(transcript: string, answer: string): void {
    const last = this.conversation[this.conversation.length - 1];
    if (last && last.transcript === transcript) last.answer = answer;
    else this.conversation.push({ transcript, answer });
    if (this.conversation.length > CONVERSATION_EXCHANGES) {
      this.conversation.splice(0, this.conversation.length - CONVERSATION_EXCHANGES);
    }
  }

  private async loadProfile(settings: CoordinatorSettings): Promise<Profile | null> {
    if (!settings.activeProfileId) return null;
    return this.deps.getProfile(settings.activeProfileId);
  }

  /**
   * Decode once, drop leading/trailing silence, and hand both forms to the
   * provider: local Whisper takes the samples straight, cloud adapters
   * upload the (smaller) re-encoded WAV — fewer bytes, and fewer audio
   * seconds counted against a free-tier quota.
   */
  private prepareAudio(wav: Uint8Array, samples: Float32Array): PreparedAudio {
    const { sampleRate } = parseWavHeader(wav);
    const at16k =
      sampleRate === TARGET_SAMPLE_RATE
        ? samples
        : resample(samples, sampleRate, TARGET_SAMPLE_RATE);
    const trimmed = trimSilence(at16k, TARGET_SAMPLE_RATE);
    if (trimmed.samples === at16k && sampleRate === TARGET_SAMPLE_RATE) {
      return { wav, samples: at16k };
    }
    return { wav: encodeWav(trimmed.samples, TARGET_SAMPLE_RATE), samples: trimmed.samples };
  }

  private transcribe(
    stt: SttProvider,
    audio: PreparedAudio,
    language: string | undefined,
    settings: CoordinatorSettings,
    signal: AbortSignal,
  ): Promise<TranscriptResult> {
    return stt.transcribe({
      audio: audio.wav,
      samples: audio.samples,
      mimeType: 'audio/wav',
      language,
      modelId: settings.sttModelId,
      signal,
    });
  }

  /**
   * Fire-and-forget LLM warmup. Run at capture-arm and again while
   * transcription is in flight, so a local model load / cloud TLS setup —
   * and, with a prefix, the prompt-cache fill — overlaps other stages
   * instead of adding to first-token latency. Identical warmups that are
   * still running are joined rather than repeated, so a slow local prefix
   * evaluation is never queued twice in front of the real request.
   * Best-effort by contract: any failure surfaces later through the real
   * generate call, with its proper error mapping.
   */
  private warmupLlm(
    settings: CoordinatorSettings,
    signal: AbortSignal,
    prefix?: WarmupPrefix,
  ): Promise<void> {
    try {
      const llm = this.deps.registry.getLlm(settings.llmProviderId);
      if (!llm.warmup) return Promise.resolve();
      const key = [
        settings.llmProviderId,
        settings.llmModelId,
        prefix?.system ?? '',
        prefix?.user ?? '',
      ].join(' ');
      if (this.lastWarmup && this.lastWarmup.key === key && !this.lastWarmup.settled) {
        return this.lastWarmup.promise;
      }
      const entry = {
        key,
        settled: false,
        promise: llm
          .warmup(settings.llmModelId, signal, prefix)
          .catch(() => undefined)
          .finally(() => {
            entry.settled = true;
          }),
      };
      this.lastWarmup = entry;
      return entry.promise;
    } catch {
      // Unknown provider IDs fail the session later with a precise error.
      return Promise.resolve();
    }
  }

  private async generate(
    context: SessionContext,
    settings: CoordinatorSettings,
    profile: Profile | null,
    transcript: string,
    options: SessionOptions,
    timing: {
      encodeMs: number;
      transcribeMs: number;
      sttSpeculative?: boolean;
      startedAt: number;
      sttProviderId?: string;
      sttModelId?: string;
    },
  ): Promise<void> {
    this.setState(context, 'generating');
    const memoryOn = settings.conversationMemory !== false;
    const prompt = buildPrompt({
      profile,
      sessionNotes: options.sessionNotes,
      transcript,
      answerMode: options.answerMode,
      targetSeconds: options.targetSeconds,
      previousExchanges: memoryOn ? this.conversation : [],
    });

    const outcome = await this.streamWithBackup(
      context,
      settings,
      prompt,
      {
        temperature: answerTemperature(options.answerMode),
        maxTokens: answerTokenBudget(options.targetSeconds),
      },
      (text) => {
        context.answer += text;
        this.emit(context, {
          type: 'answer-delta',
          sessionId: context.id,
          sequence: context.nextSequence++,
          text,
        });
      },
      ANSWER_CHAR_CAP,
    );
    if (!outcome || !this.isCurrent(context)) return;

    const answer = capText(context.answer, ANSWER_CHAR_CAP);
    const firstTokenMs =
      outcome.firstTokenAt !== undefined ? outcome.firstTokenAt - timing.startedAt : undefined;
    const metrics: SessionMetrics = {
      encodeMs: timing.encodeMs,
      transcribeMs: timing.transcribeMs,
      sttSpeculative: timing.sttSpeculative,
      firstTokenMs,
      totalMs: Date.now() - timing.startedAt,
      sttProviderId: timing.sttProviderId,
      sttModelId: timing.sttModelId,
      llmProviderId: outcome.providerId,
      llmModelId: outcome.modelId,
      usedBackup: outcome.usedBackup || undefined,
    };
    this.setState(context, 'complete');
    if (memoryOn) {
      // Emitted before answer-complete so the latter stays the final event
      // of every successful session (the renderer and tests rely on it).
      this.recordExchange(transcript, answer);
      this.emit(context, {
        type: 'conversation',
        sessionId: context.id,
        exchanges: this.conversation.length,
      });
    }
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
            llmProviderId: outcome.providerId,
            llmModelId: outcome.modelId,
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

  /**
   * The user-configured backup response model, or null when there is none,
   * it is identical to the primary, or its provider is unknown.
   */
  private backupTarget(settings: CoordinatorSettings): LlmTarget | null {
    const providerId = settings.llmBackupProviderId ?? '';
    const modelId = settings.llmBackupModelId ?? '';
    if (providerId === '' || modelId === '') return null;
    if (providerId === settings.llmProviderId && modelId === settings.llmModelId) return null;
    try {
      this.deps.registry.getLlm(providerId);
    } catch {
      return null;
    }
    return { providerId, modelId };
  }

  /**
   * Stream from the primary model; if it fails before producing anything
   * and a backup is configured, stream from the backup instead. A failure
   * after the first token is never retried — restarting would show the
   * user a second, different answer under the first one. The outcome
   * records which model actually answered so the UI can say so; null means
   * the session was retired mid-stream.
   */
  private async streamWithBackup(
    context: SessionContext,
    settings: CoordinatorSettings,
    prompt: BuiltPrompt,
    sampling: Sampling,
    onDelta: (text: string) => void,
    charCap: number,
  ): Promise<StreamOutcome | null> {
    const backup = this.backupTarget(settings);
    const primary: LlmTarget = {
      providerId: settings.llmProviderId,
      modelId: settings.llmModelId,
    };
    let produced = 0;
    const counting = (text: string) => {
      produced += text.length;
      onDelta(text);
    };
    try {
      const run = await this.stream(
        context,
        primary,
        prompt,
        sampling,
        counting,
        backup ? BACKUP_FIRST_TOKEN_TIMEOUT_MS : TIMEOUTS.llmFirstToken,
        charCap,
      );
      return run.retired ? null : { ...primary, usedBackup: false, firstTokenAt: run.firstTokenAt };
    } catch (err) {
      if (!backup || produced > 0 || !this.isCurrent(context)) throw err;
      if (toPublicError(err).code === 'REQUEST_CANCELLED') throw err;
      this.deps.recordError(
        toPublicError(err).code,
        `primary failed, using backup: ${backup.providerId}`,
      );
      const run = await this.stream(
        context,
        backup,
        prompt,
        sampling,
        counting,
        TIMEOUTS.llmFirstToken,
        charCap,
      );
      return run.retired ? null : { ...backup, usedBackup: true, firstTokenAt: run.firstTokenAt };
    }
  }

  /**
   * One streamed generation with the session's abort plumbing: a
   * first-token timeout (cleared when the first delta arrives) and a total
   * stream timeout. Deltas are handed to `onDelta` until `charCap`
   * characters have been produced.
   */
  private async stream(
    context: SessionContext,
    target: LlmTarget,
    prompt: BuiltPrompt,
    sampling: Sampling,
    onDelta: (text: string) => void,
    firstTokenTimeoutMs: number,
    charCap: number,
  ): Promise<{ firstTokenAt?: number; retired: boolean }> {
    const llm = this.deps.registry.getLlm(target.providerId);
    const firstTokenTimeout = new AbortController();
    const timer = setTimeout(() => firstTokenTimeout.abort(), firstTokenTimeoutMs);
    const signal = AbortSignal.any([
      context.controller.signal,
      AbortSignal.timeout(TIMEOUTS.llmTotal),
      firstTokenTimeout.signal,
    ]);
    let firstTokenAt: number | undefined;
    let produced = 0;
    try {
      for await (const delta of llm.generate({
        system: prompt.system,
        user: prompt.user,
        modelId: target.modelId,
        signal,
        temperature: sampling.temperature,
        maxTokens: sampling.maxTokens,
      })) {
        if (!this.isCurrent(context)) return { firstTokenAt, retired: true };
        if (firstTokenAt === undefined) {
          firstTokenAt = Date.now();
          clearTimeout(timer);
        }
        if (produced >= charCap) break;
        produced += delta.text.length;
        onDelta(delta.text);
      }
    } catch (err) {
      if (
        firstTokenTimeout.signal.aborted &&
        !context.controller.signal.aborted &&
        firstTokenAt === undefined
      ) {
        throw new CoachError('PROVIDER_TIMEOUT', 'no response from the model in time');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    return { firstTokenAt, retired: false };
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

/** Await `promise`, but give up (with an AbortError) as soon as `signal` fires. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Normalise a generated interviewer question: models like to wrap it in
 * quotes or prefix a speaker label even when told not to.
 */
function cleanQuestion(raw: string): string {
  let text = raw.replace(/\s+/g, ' ').trim();
  text = text.replace(/^(interviewer|question)\s*:\s*/i, '');
  text = text.replace(/^["'\u201c\u2018]+/, '').replace(/["'\u201d\u2019]+$/, '');
  return capText(text.trim(), FOLLOW_UP_CHAR_CAP);
}
