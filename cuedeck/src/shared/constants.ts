import type { PublicSettings } from './domain';

export const APP_NAME = 'CueDeck';

/** Sample rate (Hz) all clips are resampled to before STT. */
export const TARGET_SAMPLE_RATE = 16_000;

/** Capture length bounds (seconds). */
export const DEFAULT_MAX_CLIP_SECONDS = 90;
export const MIN_CLIP_SECONDS = 0.5;

/** RMS below this for the whole clip counts as silence. */
export const SILENCE_RMS_THRESHOLD = 0.0015;

/**
 * Trailing-silence presets for auto-respond, offered in the coach window.
 * Shorter waits shave latency off every exchange but fire on longer
 * mid-sentence pauses; the endpointer's speculative pass (see
 * `endpointing.ts`) makes the wait mostly overlap real work either way.
 */
export const PAUSE_PRESETS = [
  { ms: 1_000, label: 'Quick pause (1.0 s)' },
  { ms: 1_600, label: 'Normal pause (1.6 s)' },
  { ms: 2_400, label: 'Patient pause (2.4 s)' },
] as const;

/**
 * Idle time after which the local STT utility process is killed to give
 * its model memory back. Symmetric with OLLAMA_KEEP_ALIVE: a pause this long
 * means the practice session is over, and the capture-arm warmup reloads
 * the model during the next recording anyway.
 */
export const STT_WORKER_IDLE_MS = 15 * 60_000;

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

/** Context window requested from Ollama; large enough for the system prompt,
 *  a full profile, session notes, and a long transcript without truncation. */
export const OLLAMA_NUM_CTX = 8192;

/**
 * Extra completion tokens granted to models that reason before answering
 * (gpt-oss on Groq/Cerebras/OpenRouter): the hidden reasoning counts
 * against `max_tokens`, so a tight budget such as the interviewer's 160
 * tokens would otherwise be spent before the visible text starts.
 */
export const REASONING_TOKEN_HEADROOM = 256;

/** Default sampling values when a request does not specify its own. */
export const DEFAULT_TEMPERATURE = 0.6;
export const DEFAULT_MAX_TOKENS = 1024;

/**
 * Speculative transcriptions per clip when speech-to-text is a cloud
 * provider. Each speculative pass uploads the whole clip so far and counts
 * against the provider's audio-seconds quota, so a long question with many
 * pauses must not multiply its own length; after this many the final
 * submit simply transcribes normally. Local passes are unmetered.
 */
export const MAX_CLOUD_SPECULATIONS_PER_CLIP = 3;

/** One-use capture grant lifetime (ms). */
export const CAPTURE_GRANT_TTL_MS = 8_000;

/** Model-independent cap applied to generated answers (characters). */
export const ANSWER_CHAR_CAP = 4_000;

/** Explicit explanations/examples have enough room to finish steps and code. */
export const DETAIL_ANSWER_CHAR_CAP = 8_000;

/**
 * How many earlier question/answer pairs travel with each request so
 * follow-ups ("and how would you scale that?") are answered in context.
 * Two pairs is enough for a realistic interview thread and costs a few
 * hundred tokens; each pair is capped again at prompt-assembly time.
 */
export const CONVERSATION_EXCHANGES = 2;

/**
 * First-token patience when a backup response model is configured. A
 * healthy cloud model answers in well under this; waiting the full
 * `TIMEOUTS.llmFirstToken` before switching would defeat the backup.
 */
export const BACKUP_FIRST_TOKEN_TIMEOUT_MS = 20_000;

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
  answerMode: 'concise',
  targetSeconds: 30,
  systemPrompt: '',
  fontScale: 1,
  maxClipSeconds: DEFAULT_MAX_CLIP_SECONDS,
  autoStopOnSilence: true,
  trailingSilenceMs: 1_600,
  conversationMemory: true,
  llmBackupProviderId: '',
  llmBackupModelId: '',
  ollamaBaseUrl: OLLAMA_DEFAULT_BASE_URL,
  allowPaidModels: false,
  onboardingComplete: false,
  consentAcknowledgedAt: null,
  credentials: {},
};
