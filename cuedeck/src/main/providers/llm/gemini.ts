import { z } from 'zod';
import { CLOUD_MODELS, PROVIDERS } from '../../../shared/catalog';
import { TIMEOUTS } from '../../../shared/constants';
import type { AnswerDelta, ModelSummary, ProviderProbe } from '../../../shared/domain';
import { CoachError } from '../../../shared/errors';
import { SseParser } from '../../../shared/streaming';
import { allowlistedFetch, discardBody } from '../../security/http';
import { bodyChunks, type AnswerRequest, type LlmProvider } from '../contracts';
import { mapHttpStatus } from './openAiCompatible';

export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const streamChunkSchema = z.object({
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
 * Only 2.5 Flash variants accept `thinkingBudget: 0`; 2.5 Pro enforces a
 * minimum budget and pre-2.5 models reject thinkingConfig outright.
 */
export function supportsDisabledThinking(modelId: string): boolean {
  return modelId.includes('2.5-flash');
}

export class GeminiLlmProvider implements LlmProvider {
  readonly meta = PROVIDERS.gemini;

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

  /** Warm DNS + TLS (and key validity) while transcription runs. */
  async warmup(modelId: string, signal: AbortSignal): Promise<void> {
    const apiKey = await this.getApiKey();
    if (!apiKey) return;
    const res = await allowlistedFetch(`${this.baseUrl}/models/${modelId}`, {
      headers: { 'x-goog-api-key': apiKey },
      signal,
      timeoutMs: TIMEOUTS.warmup,
    });
    discardBody(res);
  }

  async *generate(input: AnswerRequest): AsyncIterable<AnswerDelta> {
    const apiKey = await this.getApiKey();
    if (!apiKey) throw new CoachError('CREDENTIAL_MISSING', 'Gemini API key not configured');
    const res = await allowlistedFetch(
      `${this.baseUrl}/models/${input.modelId}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: input.system }] },
          contents: [{ role: 'user', parts: [{ text: input.user }] }],
          generationConfig: {
            maxOutputTokens: 1024,
            temperature: 0.6,
            // 2.5 Flash "thinks" before answering by default, which delays
            // the first token by seconds. Short spoken cues don't need it.
            ...(supportsDisabledThinking(input.modelId)
              ? { thinkingConfig: { thinkingBudget: 0 } }
              : {}),
          },
        }),
        signal: input.signal,
        timeoutMs: TIMEOUTS.llmTotal,
      },
    );
    if (!res.ok) {
      discardBody(res);
      throw mapHttpStatus(res.status, 'Gemini');
    }
    const parser = new SseParser();
    let sequence = 0;
    const handle = (data: string): AnswerDelta | null => {
      let obj: unknown;
      try {
        obj = JSON.parse(data);
      } catch {
        return null;
      }
      const parsed = streamChunkSchema.safeParse(obj);
      if (!parsed.success) return null;
      const text =
        parsed.data.candidates[0]?.content?.parts.map((p) => p.text ?? '').join('') ?? '';
      if (!text) return null;
      return { text, sequence: sequence++ };
    };
    for await (const bytes of bodyChunks(res)) {
      for (const data of parser.push(bytes)) {
        const delta = handle(data);
        if (delta) yield delta;
      }
    }
    for (const data of parser.end()) {
      const delta = handle(data);
      if (delta) yield delta;
    }
  }
}
