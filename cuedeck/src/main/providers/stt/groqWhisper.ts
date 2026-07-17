import { z } from 'zod';
import { CLOUD_MODELS, PROVIDERS } from '../../../shared/catalog';
import { TIMEOUTS } from '../../../shared/constants';
import type { ModelSummary, ProviderProbe, TranscriptResult } from '../../../shared/domain';
import { CoachError } from '../../../shared/errors';
import { allowlistedFetch, discardBody } from '../../security/http';
import type { SttProvider, TranscribeInput } from '../contracts';
import { mapHttpStatus, probeOpenAiCompatible } from '../llm/openAiCompatible';
import { GROQ_DEFAULT_BASE_URL } from '../llm/groq';

const transcriptionSchema = z.object({
  text: z.string(),
  language: z.string().optional(),
  duration: z.number().optional(),
  segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })).optional(),
});

/** Conservative client-side upload cap; well under Groq's free-tier 25 MB. */
export const GROQ_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export class GroqWhisperProvider implements SttProvider {
  readonly meta = PROVIDERS['groq-whisper'];

  constructor(
    private readonly getApiKey: () => Promise<string | null>,
    private readonly baseUrl: string = GROQ_DEFAULT_BASE_URL,
  ) {}

  async probe(signal: AbortSignal): Promise<ProviderProbe> {
    return probeOpenAiCompatible({
      baseUrl: this.baseUrl,
      apiKey: await this.getApiKey(),
      providerName: 'Groq',
      meta: this.meta,
      signal,
    });
  }

  async listModels(): Promise<ModelSummary[]> {
    return [
      {
        id: CLOUD_MODELS.groqSttModel,
        displayName: `${CLOUD_MODELS.groqSttModel} (free plan)`,
        providerId: this.meta.id,
      },
    ];
  }

  async transcribe(input: TranscribeInput): Promise<TranscriptResult> {
    const apiKey = await this.getApiKey();
    if (!apiKey) throw new CoachError('CREDENTIAL_MISSING', 'Groq API key not configured');
    if (input.audio.byteLength > GROQ_MAX_UPLOAD_BYTES) {
      throw new CoachError('AUDIO_TOO_LONG', 'clip exceeds the upload limit');
    }
    const form = new FormData();
    form.set('model', input.modelId);
    form.set('response_format', 'verbose_json');
    if (input.language && input.language !== 'auto') form.set('language', input.language);
    form.set(
      'file',
      new Blob([input.audio as BufferSource], { type: input.mimeType }),
      input.mimeType === 'audio/flac' ? 'clip.flac' : 'clip.wav',
    );
    const res = await allowlistedFetch(`${this.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: input.signal,
      timeoutMs: TIMEOUTS.cloudStt,
    });
    if (!res.ok) {
      discardBody(res);
      throw mapHttpStatus(res.status, 'Groq');
    }
    const parsed = transcriptionSchema.parse(await res.json());
    return {
      text: parsed.text.trim(),
      language: parsed.language,
      durationMs: parsed.duration !== undefined ? parsed.duration * 1000 : undefined,
      segments: parsed.segments?.map((s) => ({
        startMs: s.start * 1000,
        endMs: s.end * 1000,
        text: s.text,
      })),
    };
  }
}
