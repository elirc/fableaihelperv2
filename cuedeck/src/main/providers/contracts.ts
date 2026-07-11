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
}

export interface AnswerRequest {
  system: string;
  user: string;
  modelId: string;
  signal: AbortSignal;
}

export interface LlmProvider {
  meta: ProviderMeta;
  probe(signal: AbortSignal): Promise<ProviderProbe>;
  listModels(signal: AbortSignal): Promise<ModelSummary[]>;
  generate(input: AnswerRequest): AsyncIterable<AnswerDelta>;
}

/** Read a fetch Response body as an async iterable of Uint8Array chunks. */
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
    reader.releaseLock();
  }
}
