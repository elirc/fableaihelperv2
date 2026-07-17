import { z } from 'zod';
import { CLOUD_MODELS, PROVIDERS } from '../../../shared/catalog';
import { TIMEOUTS } from '../../../shared/constants';
import type { ModelSummary, ProviderProbe, TranscriptResult } from '../../../shared/domain';
import { CoachError } from '../../../shared/errors';
import { allowlistedFetch, discardBody } from '../../security/http';
import type { SttProvider, TranscribeInput } from '../contracts';
import { GEMINI_DEFAULT_BASE_URL } from '../llm/gemini';
import { mapHttpStatus } from '../llm/openAiCompatible';

const responseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({ parts: z.array(z.object({ text: z.string().optional() })).default([]) })
          .optional(),
      }),
    )
    .default([]),
});

/**
 * Two-step Gemini path (spec §12.4): this adapter only transcribes; answer
 * generation stays a separate auditable request so transcript editing and
 * answer modes work identically across providers.
 */
export class GeminiAudioProvider implements SttProvider {
  readonly meta = PROVIDERS['gemini-audio'];

  constructor(
    private readonly getApiKey: () => Promise<string | null>,
    private readonly baseUrl: string = GEMINI_DEFAULT_BASE_URL,
  ) {}

  async probe(signal: AbortSignal): Promise<ProviderProbe> {
    const apiKey = await this.getApiKey();
    if (!apiKey) return { providerId: this.meta.id, status: 'missing-credential' };
    const started = Date.now();
    try {
      const res = await allowlistedFetch(`${this.baseUrl}/models/${CLOUD_MODELS.geminiModel}`, {
        headers: { 'x-goog-api-key': apiKey },
        signal,
        timeoutMs: TIMEOUTS.probe,
      });
      discardBody(res); // probes only inspect the status line
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        return {
          providerId: this.meta.id,
          status: 'missing-credential',
          detail: 'API key rejected',
        };
      }
      if (res.status === 429) return { providerId: this.meta.id, status: 'quota-limited' };
      if (!res.ok)
        return {
          providerId: this.meta.id,
          status: 'unknown-failure',
          detail: `HTTP ${res.status}`,
        };
      return { providerId: this.meta.id, status: 'ready', latencyMs: Date.now() - started };
    } catch (err) {
      return {
        providerId: this.meta.id,
        status: 'unreachable',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async listModels(): Promise<ModelSummary[]> {
    return [
      {
        id: CLOUD_MODELS.geminiModel,
        displayName: `${CLOUD_MODELS.geminiModel} (free tier)`,
        providerId: this.meta.id,
      },
    ];
  }

  async transcribe(input: TranscribeInput): Promise<TranscriptResult> {
    const apiKey = await this.getApiKey();
    if (!apiKey) throw new CoachError('CREDENTIAL_MISSING', 'Gemini API key not configured');
    const instruction =
      input.language && input.language !== 'auto'
        ? `Transcribe this audio verbatim in ${input.language}. Output only the transcript text.`
        : 'Transcribe this audio verbatim. Output only the transcript text.';
    const res = await allowlistedFetch(`${this.baseUrl}/models/${input.modelId}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: instruction },
              {
                inline_data: {
                  mime_type: input.mimeType,
                  data: Buffer.from(input.audio).toString('base64'),
                },
              },
            ],
          },
        ],
        generationConfig: { temperature: 0 },
      }),
      signal: input.signal,
      timeoutMs: TIMEOUTS.cloudStt,
    });
    if (!res.ok) {
      discardBody(res);
      throw mapHttpStatus(res.status, 'Gemini');
    }
    const parsed = responseSchema.parse(await res.json());
    const text = parsed.candidates[0]?.content?.parts.map((p) => p.text ?? '').join('') ?? '';
    return { text: text.trim() };
  }
}
