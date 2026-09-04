import { z } from 'zod';
import { CLOUD_MODELS, PROVIDERS } from '../../../shared/catalog';
import { DEFAULT_MAX_TOKENS, DEFAULT_TEMPERATURE, TIMEOUTS } from '../../../shared/constants';
import type { AnswerDelta, ModelSummary, ProviderProbe } from '../../../shared/domain';
import { CoachError } from '../../../shared/errors';
import { SseParser } from '../../../shared/streaming';
import { allowlistedFetch, discardBody } from '../../security/http';
import { bodyChunks, type AnswerRequest, type LlmProvider } from '../contracts';
import { mapErrorFrame, mapHttpStatus } from './openAiCompatible';

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
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
});

const errorBodySchema = z.object({
  error: z.object({
    message: z.string().optional(),
    status: z.string().optional(),
    details: z.array(z.object({ reason: z.string().optional() }).passthrough()).default([]),
  }),
});

/**
 * Gemini reports a revoked or malformed key as HTTP 400 (`API_KEY_INVALID`)
 * rather than 401, so a 400 has to be read before it can be classified.
 * Consumes the body of a 400; every other status is left untouched.
 */
export async function isGeminiKeyRejection(res: Response): Promise<boolean> {
  if (res.status === 401 || res.status === 403) return true;
  if (res.status !== 400) return false;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return false;
  }
  const parsed = errorBodySchema.safeParse(body);
  if (!parsed.success) return false;
  const { message, details } = parsed.data.error;
  return details.some((d) => d.reason === 'API_KEY_INVALID') || /api key/i.test(message ?? '');
}

/** Map a non-OK Gemini response, releasing its body. */
export async function mapGeminiError(res: Response): Promise<CoachError> {
  const keyRejected = await isGeminiKeyRejection(res);
  discardBody(res);
  if (keyRejected) {
    return new CoachError('CREDENTIAL_REJECTED', `Gemini rejected the API key (${res.status})`);
  }
  return mapHttpStatus(res.status, 'Gemini');
}

/** Shared probe for the Gemini LLM and audio adapters (same key, same endpoint). */
export async function probeGemini(options: {
  providerId: ProviderProbe['providerId'];
  baseUrl: string;
  apiKey: string | null;
  signal: AbortSignal;
}): Promise<ProviderProbe> {
  const { providerId, apiKey } = options;
  if (!apiKey) return { providerId, status: 'missing-credential' };
  const started = Date.now();
  try {
    const res = await allowlistedFetch(`${options.baseUrl}/models/${CLOUD_MODELS.geminiModel}`, {
      headers: { 'x-goog-api-key': apiKey },
      signal: options.signal,
      timeoutMs: TIMEOUTS.probe,
    });
    const keyRejected = await isGeminiKeyRejection(res);
    discardBody(res); // probes only inspect the status line (plus a 400 body)
    if (keyRejected)
      return { providerId, status: 'missing-credential', detail: 'API key rejected' };
    if (res.status === 429) return { providerId, status: 'quota-limited' };
    if (!res.ok) return { providerId, status: 'unknown-failure', detail: `HTTP ${res.status}` };
    return { providerId, status: 'ready', latencyMs: Date.now() - started };
  } catch (err) {
    return {
      providerId,
      status: 'unreachable',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

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
    return probeGemini({
      providerId: this.meta.id,
      baseUrl: this.baseUrl,
      apiKey: await this.getApiKey(),
      signal,
    });
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
            maxOutputTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
            temperature: input.temperature ?? DEFAULT_TEMPERATURE,
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
    if (!res.ok) throw await mapGeminiError(res);
    const parser = new SseParser();
    let sequence = 0;
    const handle = (data: string): AnswerDelta | null => {
      let obj: unknown;
      try {
        obj = JSON.parse(data);
      } catch {
        return null;
      }
      const failure = mapErrorFrame(obj, 'Gemini');
      if (failure) throw failure;
      const parsed = streamChunkSchema.safeParse(obj);
      if (!parsed.success) return null;
      // A blocked prompt streams no candidates at all; ending silently would
      // read as an empty answer rather than a refusal.
      const blockReason = parsed.data.promptFeedback?.blockReason;
      if (blockReason) {
        throw new CoachError('PROVIDER_UNAVAILABLE', `Gemini blocked the prompt (${blockReason})`);
      }
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
