import type { PublicError, PublicErrorCode } from './domain';

interface ErrorTemplate {
  message: string;
  retryable: boolean;
  action?: PublicError['action'];
}

const TEMPLATES: Record<PublicErrorCode, ErrorTemplate> = {
  CAPTURE_DENIED: {
    message: 'System audio capture was not permitted. Start recording from the Listen button.',
    retryable: true,
  },
  CAPTURE_NO_AUDIO: {
    message: 'No audio track was available from the capture source.',
    retryable: true,
    action: 'open-diagnostics',
  },
  CAPTURE_SILENT: {
    message: 'The recording was silent. Check that the right output device is playing audio.',
    retryable: true,
    action: 'open-diagnostics',
  },
  AUDIO_TOO_SHORT: {
    message: 'The clip was too short to transcribe. Record at least half a second.',
    retryable: true,
  },
  AUDIO_TOO_LONG: {
    message: 'The clip exceeded the maximum length.',
    retryable: true,
  },
  MODEL_NOT_INSTALLED: {
    message: 'The selected model is not installed yet.',
    retryable: false,
    action: 'download-model',
  },
  LOCAL_PROVIDER_UNREACHABLE: {
    message: 'The local model server could not be reached. Is Ollama running?',
    retryable: true,
    action: 'open-diagnostics',
  },
  CREDENTIAL_MISSING: {
    message: 'This provider needs an API key before it can be used.',
    retryable: false,
    action: 'replace-key',
  },
  CREDENTIAL_REJECTED: {
    message: 'The provider rejected the saved API key.',
    retryable: false,
    action: 'replace-key',
  },
  PROVIDER_RATE_LIMITED: {
    message: 'The provider rate-limited this request. Wait a moment and try again.',
    retryable: true,
  },
  PROVIDER_TIMEOUT: {
    message: 'The provider took too long to respond.',
    retryable: true,
  },
  PROVIDER_UNAVAILABLE: {
    message: 'The provider is currently unavailable.',
    retryable: true,
    action: 'switch-provider',
  },
  TRANSCRIPT_EMPTY: {
    message: 'Nothing intelligible was heard in the clip.',
    retryable: true,
  },
  REQUEST_CANCELLED: {
    message: 'The request was cancelled.',
    retryable: true,
  },
  STORAGE_FAILED: {
    message: 'Saving data to disk failed.',
    retryable: true,
    action: 'open-diagnostics',
  },
  UNKNOWN: {
    message: 'Something unexpected went wrong.',
    retryable: true,
    action: 'open-diagnostics',
  },
};

/** Build the canonical PublicError for a code. `detail` is developer-facing
 *  context (surfaced in diagnostics) and must not contain secrets. */
export function publicError(code: PublicErrorCode, detail?: string): PublicError {
  const t = TEMPLATES[code];
  return { code, message: t.message, retryable: t.retryable, action: t.action, detail };
}

/** Error subclass carrying a PublicError across internal layers. */
export class CoachError extends Error {
  readonly public: PublicError;

  constructor(code: PublicErrorCode, detail?: string) {
    const p = publicError(code, detail);
    super(`${code}: ${detail ?? p.message}`);
    this.name = 'CoachError';
    this.public = p;
  }
}

/** Map any thrown value to a PublicError, treating aborts as cancellation. */
export function toPublicError(err: unknown): PublicError {
  if (err instanceof CoachError) return err.public;
  if (err instanceof Error) {
    // Check TimeoutError before the abort heuristic: Node's AbortSignal.timeout()
    // rejects with a TimeoutError whose message is "The operation was aborted due
    // to timeout", which /abort/i would otherwise misreport as a cancellation.
    if (err.name === 'TimeoutError') return publicError('PROVIDER_TIMEOUT');
    if (err.name === 'AbortError' || /abort/i.test(err.message)) {
      return publicError('REQUEST_CANCELLED');
    }
    return publicError('UNKNOWN', err.message);
  }
  return publicError('UNKNOWN', String(err));
}
