import { z } from 'zod';
import { PROVIDERS } from '../../../shared/catalog';
import { OLLAMA_KEEP_ALIVE, OLLAMA_NUM_CTX, TIMEOUTS } from '../../../shared/constants';
import type { AnswerDelta, ModelSummary, ProviderProbe } from '../../../shared/domain';
import { CoachError } from '../../../shared/errors';
import { NdjsonParser } from '../../../shared/streaming';
import { allowlistedFetch, discardBody } from '../../security/http';
import { bodyChunks, type AnswerRequest, type LlmProvider, type WarmupPrefix } from '../contracts';

const tagsSchema = z.object({
  models: z.array(z.object({ name: z.string(), size: z.number().optional() })).default([]),
});

const chatChunkSchema = z.object({
  message: z.object({ content: z.string().default('') }).optional(),
  done: z.boolean().default(false),
  error: z.string().optional(),
});

/**
 * Options that decide how Ollama loads the model. Shared by warmup and
 * generate so both address the same resident instance.
 */
function runnerOptions(): { num_ctx: number } {
  return {
    // Many Ollama models default to a 2-4k context; a long profile plus
    // transcript would overflow it and Ollama drops the oldest tokens first
    // — i.e. the system prompt — without any error.
    num_ctx: OLLAMA_NUM_CTX,
  };
}

/**
 * Local LLM via the Ollama HTTP API (spec §12.2). Loopback by default;
 * a non-loopback base URL requires explicit confirmation in preferences
 * because prompts and profile data would leave the device.
 */
export class OllamaProvider implements LlmProvider {
  readonly meta = PROVIDERS.ollama;

  constructor(private readonly getBaseUrl: () => Promise<string>) {}

  private async base(): Promise<string> {
    const url = (await this.getBaseUrl()).replace(/\/+$/, '');
    return url;
  }

  async probe(signal: AbortSignal): Promise<ProviderProbe> {
    const started = Date.now();
    try {
      const models = await this.listModels(signal);
      return {
        providerId: this.meta.id,
        status: models.length > 0 ? 'ready' : 'missing-model',
        latencyMs: Date.now() - started,
        models,
        detail: models.length === 0 ? 'Ollama is running but no models are installed.' : undefined,
      };
    } catch (err) {
      return {
        providerId: this.meta.id,
        status: 'unreachable',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async listModels(signal: AbortSignal): Promise<ModelSummary[]> {
    const res = await allowlistedFetch(`${await this.base()}/api/tags`, {
      signal,
      timeoutMs: TIMEOUTS.probe,
    });
    if (!res.ok) {
      discardBody(res);
      throw new CoachError('LOCAL_PROVIDER_UNREACHABLE', `Ollama responded ${res.status}`);
    }
    const parsed = tagsSchema.parse(await res.json());
    return parsed.models.map((m) => ({
      id: m.name,
      displayName: m.name,
      providerId: this.meta.id,
      installed: true,
      sizeBytes: m.size,
    }));
  }

  /**
   * Preload the model while the clip is still being recorded. Without a
   * prefix, /api/chat with an empty messages array just loads the weights
   * (Ollama FAQ). With one, a single-token generation over the real system
   * prompt and profile fills the prompt cache: Ollama reuses the KV cache
   * for a matching prompt prefix, so the real request's prompt evaluation
   * — the visible part of first-token latency on CPU — starts at the
   * transcript instead of token zero.
   *
   * The runner options must match `generate` exactly: Ollama reloads the
   * model whenever `num_ctx` (or any runner option) differs from the
   * resident instance, which would turn the warmup into a second cold start.
   */
  async warmup(modelId: string, signal: AbortSignal, prefix?: WarmupPrefix): Promise<void> {
    const body = prefix
      ? {
          model: modelId,
          stream: false,
          think: false,
          keep_alive: OLLAMA_KEEP_ALIVE,
          options: { ...runnerOptions(), num_predict: 1 },
          messages: [
            { role: 'system', content: prefix.system },
            { role: 'user', content: prefix.user },
          ],
        }
      : {
          model: modelId,
          messages: [],
          keep_alive: OLLAMA_KEEP_ALIVE,
          options: runnerOptions(),
        };
    const res = await allowlistedFetch(`${await this.base()}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      timeoutMs: TIMEOUTS.warmup,
    });
    discardBody(res);
  }

  async *generate(input: AnswerRequest): AsyncIterable<AnswerDelta> {
    const base = await this.base();
    let res: Response;
    try {
      res = await allowlistedFetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: input.modelId,
          stream: true,
          think: false,
          // Keep the model resident between turns; reloading it dominates
          // first-token latency on consecutive answers otherwise.
          keep_alive: OLLAMA_KEEP_ALIVE,
          options: {
            ...runnerOptions(),
            num_predict: input.maxTokens ?? 700,
            temperature: input.temperature ?? 0.6,
          },
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.user },
          ],
        }),
        signal: input.signal,
        timeoutMs: TIMEOUTS.llmTotal,
      });
    } catch (err) {
      if (err instanceof CoachError) throw err;
      if (err instanceof Error && err.name === 'AbortError') throw err;
      throw new CoachError('LOCAL_PROVIDER_UNREACHABLE', 'could not connect to Ollama');
    }
    if (res.status === 404) {
      discardBody(res);
      throw new CoachError(
        'MODEL_NOT_INSTALLED',
        `model ${input.modelId} is not installed in Ollama`,
      );
    }
    if (!res.ok) {
      discardBody(res);
      throw new CoachError('PROVIDER_UNAVAILABLE', `Ollama responded ${res.status}`);
    }
    const parser = new NdjsonParser();
    let sequence = 0;
    const handle = (obj: unknown): AnswerDelta | null => {
      const chunk = chatChunkSchema.safeParse(obj);
      if (!chunk.success) return null;
      if (chunk.data.error) throw new CoachError('PROVIDER_UNAVAILABLE', chunk.data.error);
      const text = chunk.data.message?.content ?? '';
      if (text === '') return null;
      return { text, sequence: sequence++ };
    };
    for await (const bytes of bodyChunks(res)) {
      for (const obj of parser.push(bytes)) {
        const delta = handle(obj);
        if (delta) yield delta;
      }
    }
    for (const obj of parser.end()) {
      const delta = handle(obj);
      if (delta) yield delta;
    }
  }
}
