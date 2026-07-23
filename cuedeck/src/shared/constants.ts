import type { PublicSettings } from './domain';

export const APP_NAME = 'CueDeck';

/** Sample rate (Hz) all clips are resampled to before STT. */
export const TARGET_SAMPLE_RATE = 16_000;

/** Capture length bounds (seconds). */
export const DEFAULT_MAX_CLIP_SECONDS = 90;
export const MIN_CLIP_SECONDS = 0.5;

/** RMS below this for the whole clip counts as silence. */
export const SILENCE_RMS_THRESHOLD = 0.0015;

/** Stage timeouts (ms). */
export const TIMEOUTS = {
  probe: 15_000,
  cloudStt: 45_000,
  localStt: 120_000,
  llmFirstToken: 60_000,
  llmTotal: 120_000,
  /** Best-effort LLM warmup fired while transcription runs. */
  warmup: 30_000,
} as const;

/**
 * How long Ollama keeps the model resident after a request. Kept well above
 * a typical practice-session pause so consecutive answers skip the model
 * load (multi-second cold start on first token).
 */
export const OLLAMA_KEEP_ALIVE = '15m';

/** One-use capture grant lifetime (ms). */
export const CAPTURE_GRANT_TTL_MS = 8_000;

/** Model-independent cap applied to generated answers (characters). */
export const ANSWER_CHAR_CAP = 4_000;

/**
 * Average spoken pace assumed everywhere a word count is converted to
 * speaking time: the prompt's word target and the answer pace estimate
 * must stay in agreement, so both derive from this one number.
 */
export const SPOKEN_WORDS_PER_SECOND = 2.5;

export const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

/** Hosts the privileged process may contact. Loopback is always allowed. */
export const ALLOWED_HOSTS = [
  'api.groq.com',
  'api.cerebras.ai',
  'generativelanguage.googleapis.com',
  'openrouter.ai',
  'huggingface.co',
  'cdn-lfs.huggingface.co',
  'cdn-lfs-us-1.huggingface.co',
  'cas-bridge.xethub.hf.co',
] as const;

/** HTTPS URLs the app may hand to shell.openExternal. */
export const EXTERNAL_LINK_ALLOWLIST = [
  'https://ollama.com/download',
  'https://ollama.com/library',
  'https://console.groq.com/keys',
  'https://console.groq.com/docs/rate-limits',
  'https://cloud.cerebras.ai',
  'https://www.cerebras.ai/privacy',
  'https://aistudio.google.com/apikey',
  'https://ai.google.dev/gemini-api/docs/pricing',
  'https://openrouter.ai/keys',
  'https://openrouter.ai/docs/api/reference/limits/',
  'https://huggingface.co',
  'https://groq.com/privacy-policy',
  'https://policies.google.com/privacy',
  'https://openrouter.ai/privacy',
] as const;

/** Settings written on first run; local-only providers, history off. */
export const DEFAULT_SETTINGS: PublicSettings = {
  schemaVersion: 1,
  theme: 'dark',
  alwaysOnTop: false,
  compactMode: false,
  historyEnabled: false,
  historyRetentionDays: 7,
  sttProviderId: 'local-whisper',
  sttModelId: 'onnx-community/whisper-base',
  sttLanguage: 'auto',
  llmProviderId: 'ollama',
  llmModelId: '',
  answerMode: 'natural',
  targetSeconds: 30,
  fontScale: 1,
  maxClipSeconds: DEFAULT_MAX_CLIP_SECONDS,
  autoStopOnSilence: true,
  ollamaBaseUrl: OLLAMA_DEFAULT_BASE_URL,
  onboardingComplete: false,
  consentAcknowledgedAt: null,
  credentials: {},
};
