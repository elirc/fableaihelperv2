import type {
  AnswerDelta,
  ModelSummary,
  ProviderMeta,
  ProviderProbe,
  TranscriptResult,
} from '../../shared/domain';

export interface TranscribeInput {
  audio: Uint8Array;
  mimeType: 'audio/wav' | 'audio/flac';
  language?: string;
  modelId: string;
  signal: AbortSignal;
}

export interface SttProvider {
  meta: ProviderMeta;
  probe(signal: AbortSignal): Promise<ProviderProbe>;
  listModels(signal: AbortSignal): Promise<ModelSummary[]>;
  transcribe(input: TranscribeInput): Promise<TranscriptResult>;
  /**
   * Best-effort preparation fired when capture is armed, so a local model
   * loads while the clip is still being recorded instead of inside the
   * transcribe stage. Must never trigger a download; cheap, idempotent,
   * safe to fail.
   */
  warmup?(modelId: string, signal: AbortSignal): Promise<void>;
}

export interface AnswerRequest {
  system: string;
  user: string;
  modelId: string;
  signal: AbortSignal;
  /** Sampling temperature; adapters fall back to a conservative default. */
  temperature?: number;
  /** Output-token ceiling for this answer. */
  maxTokens?: number;
}

export interface LlmProvider {
  meta: ProviderMeta;
  probe(signal: AbortSignal): Promise<ProviderProbe>;
  listModels(signal: AbortSignal): Promise<ModelSummary[]>;
  generate(input: AnswerRequest): AsyncIterable<AnswerDelta>;
  /**
   * Best-effort preparation fired while transcription is still running so
   * the first answer token arrives sooner: local providers load the model
   * into memory, cloud providers open a keep-alive TLS connection. Must be
   * cheap, idempotent, and safe to fail — the coordinator ignores errors.
   */
  warmup?(modelId: string, signal: AbortSignal): Promise<void>;
}

/**
 * Read a fetch Response body as an async iterable of Uint8Array chunks.
 * Cancels the underlying stream when iteration stops early (break, return,
 * or throw in the consumer) so the socket is released instead of silently
 * buffering the rest of the response.
 */
export async function* bodyChunks(response: Response): AsyncIterable<Uint8Array> {
  if (!response.body) return;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
