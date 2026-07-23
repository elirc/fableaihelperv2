/**
 * Core domain types shared by the main process, preload, and renderer.
 * Everything crossing the IPC boundary is validated against the Zod
 * schemas in `schemas.ts`; these types are the static views of them.
 */

/** Where a provider runs; drives consent/disclosure UI for cloud providers. */
export type ProcessingLocation = 'local' | 'cloud';

export type FreePolicy = 'always-free-local' | 'provider-free-tier';

/** Answer style requested by the user ('star' = Situation/Task/Action/Result). */
export type AnswerMode = 'natural' | 'concise' | 'bullets' | 'star' | 'clarify';

/** Desired spoken length of the generated answer, in seconds. */
export type TargetSeconds = 15 | 30 | 60;

/** Session lifecycle. One session = one capture→transcribe→generate pipeline. */
export type SessionState =
  | 'unconfigured'
  | 'checking'
  | 'ready'
  | 'arming_capture'
  | 'recording'
  | 'encoding'
  | 'transcribing'
  | 'generating'
  | 'complete'
  | 'cancelling'
  | 'failed';

export const PUBLIC_ERROR_CODES = [
  'CAPTURE_DENIED',
  'CAPTURE_NO_AUDIO',
  'CAPTURE_SILENT',
  'AUDIO_TOO_SHORT',
  'AUDIO_TOO_LONG',
  'MODEL_NOT_INSTALLED',
  'LOCAL_PROVIDER_UNREACHABLE',
  'CREDENTIAL_MISSING',
  'CREDENTIAL_REJECTED',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'TRANSCRIPT_EMPTY',
  'REQUEST_CANCELLED',
  'STORAGE_FAILED',
  'UNKNOWN',
] as const;

export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[number];

/**
 * Sanitized error safe to cross the IPC boundary and show in the UI.
 * `detail` may carry provider text and must be redacted before logging.
 */
export interface PublicError {
  code: PublicErrorCode;
  message: string;
  retryable: boolean;
  action?: 'open-diagnostics' | 'replace-key' | 'download-model' | 'switch-provider';
  detail?: string;
}

export interface ProviderMeta {
  id: string;
  displayName: string;
  location: ProcessingLocation;
  freePolicy: FreePolicy;
  supportsAbort: boolean;
  kind: 'stt' | 'llm';
  /**
   * Secret-vault key this provider reads its API key from. Defaults to `id`;
   * set it when several adapters share one account (e.g. Groq STT + LLM).
   */
  credentialId?: string;
  /** Link to the provider's data-use documentation (cloud providers only). */
  dataUseUrl?: string;
  /** Shown before the provider can be enabled. */
  disclosure?: string;
}

/** Outcome of a provider health probe (providers:probe). */
export type ProbeStatus =
  | 'ready'
  | 'missing-credential'
  | 'unreachable'
  | 'missing-model'
  | 'quota-limited'
  | 'unsupported'
  | 'unknown-failure';

export interface ProviderProbe {
  providerId: string;
  status: ProbeStatus;
  detail?: string;
  latencyMs?: number;
  models?: ModelSummary[];
}

export interface ModelSummary {
  id: string;
  displayName: string;
  providerId: string;
  installed?: boolean;
  sizeBytes?: number;
  license?: string;
}

/** One timed span of a transcript. Offsets are milliseconds from clip start. */
export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

/** STT output. `durationMs` is the audio length in milliseconds when the
 *  provider reports it. */
export interface TranscriptResult {
  text: string;
  language?: string;
  durationMs?: number;
  segments?: TranscriptSegment[];
}

/** Streamed answer fragment. `sequence` increases by 1 per delta so the
 *  renderer can detect gaps or reordering. */
export interface AnswerDelta {
  text: string;
  sequence: number;
}

/** Stage timings for a completed session. All durations in milliseconds. */
export interface SessionMetrics {
  encodeMs?: number;
  transcribeMs?: number;
  firstTokenMs?: number;
  totalMs: number;
  sttProviderId?: string;
  sttModelId?: string;
  llmProviderId?: string;
  llmModelId?: string;
}

/** Push events emitted main→renderer over the session channel. */
export type SessionEvent =
  | { type: 'state'; sessionId: string; state: SessionState }
  | { type: 'transcript'; sessionId: string; text: string; language?: string }
  | { type: 'answer-delta'; sessionId: string; sequence: number; text: string }
  | { type: 'answer-complete'; sessionId: string; text: string; metrics: SessionMetrics }
  | { type: 'progress'; sessionId: string; stage: string; value?: number }
  | { type: 'error'; sessionId: string; error: PublicError };

/** Push events for long-running non-session work (e.g. model downloads). */
export type OperationEvent =
  | { type: 'progress'; operationId: string; stage: string; value?: number; detail?: string }
  | { type: 'complete'; operationId: string }
  | { type: 'error'; operationId: string; error: PublicError };

/** User background fed into prompts as untrusted reference data.
 *  `createdAt`/`updatedAt` are ISO 8601 strings. */
export interface Profile {
  id: string;
  name: string;
  summary: string;
  roleContext: string;
  emphasisNotes: string;
  createdAt: string;
  updatedAt: string;
}

/** Persisted record of one completed session (only when history is enabled). */
export interface HistoryItem {
  id: string;
  createdAt: string;
  transcript: string;
  answer: string;
  sttProviderId: string;
  sttModelId: string;
  llmProviderId: string;
  llmModelId: string;
  answerMode: string;
  timings: {
    encodeMs: number;
    transcribeMs: number;
    firstTokenMs?: number;
    totalMs: number;
  };
}

/** Renderer-visible settings. Never contains secret values: `credentials`
 *  only exposes whether a key is configured per provider. */
export interface PublicSettings {
  schemaVersion: number;
  theme: 'dark' | 'system';
  alwaysOnTop: boolean;
  compactMode: boolean;
  historyEnabled: boolean;
  historyRetentionDays: 1 | 7 | 30 | 0;
  sttProviderId: string;
  sttModelId: string;
  sttLanguage: string;
  llmProviderId: string;
  llmModelId: string;
  answerMode: AnswerMode;
  targetSeconds: TargetSeconds;
  fontScale: number;
  maxClipSeconds: number;
  /** Stop and submit automatically when the speaker pauses (endpointing). */
  autoStopOnSilence: boolean;
  activeProfileId?: string;
  ollamaBaseUrl: string;
  onboardingComplete: boolean;
  consentAcknowledgedAt: string | null;
  credentials: Record<string, { configured: boolean }>;
}

/** Static environment facts reported once at startup. */
export interface AppCapabilities {
  appVersion: string;
  electronVersion: string;
  platform: string;
  osVersion: string;
  safeStorageAvailable: boolean;
  totalMemoryMb: number;
}

/** Per-session knobs chosen at submit time. `sessionNotes` is untrusted
 *  free text and is fenced when embedded in prompts. */
export interface SessionOptions {
  answerMode: AnswerMode;
  targetSeconds: TargetSeconds;
  language?: string;
  sessionNotes?: string;
}

/** Redacted snapshot for the diagnostics export; must stay free of secrets
 *  and, unless the user opts in, transcripts. */
export interface DiagnosticsReport {
  appVersion: string;
  electronVersion: string;
  platform: string;
  osVersion: string;
  sttProviderId: string;
  llmProviderId: string;
  localModelStatus: string;
  recentErrors: Array<{ at: string; code: string; message: string }>;
}
