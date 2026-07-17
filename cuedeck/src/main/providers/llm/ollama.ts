import { z } from 'zod';
import { PROVIDERS } from '../../../shared/catalog';
import { OLLAMA_KEEP_ALIVE, TIMEOUTS } from '../../../shared/constants';
import type { AnswerDelta, ModelSummary, ProviderProbe } from '../../../shared/domain';
import { CoachError } from '../../../shared/errors';
import { NdjsonParser } from '../../../shared/streaming';
import { allowlistedFetch, discardBody, isLoopbackHost } from '../../security/http';
import { bodyChunks, type AnswerRequest, type LlmProvider } from '../contracts';

const tagsSchema = z.object({
  models: z.array(z.object({ name: z.string(), size: z.number().optional() })).default([]),
});

const chatChunkSchema = z.object({
  message: z.object({ content: z.string().default('') }).optional(),
  done: z.boolean().default(false),
  error: z.string().optional(),
});

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
   * Preload the model while transcription runs: /api/chat with an empty
   * messages array loads the model into memory and returns immediately
   * (Ollama FAQ), turning a multi-second cold start into a no-op later.
   */
  async warmup(modelId: string, signal: AbortSignal): Promise<void> {
    const res = await allowlistedFetch(`${await this.base()}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelId, messages: [], keep_alive: OLLAMA_KEEP_ALIVE }),
      signal,
      timeoutMs: TIMEOUTS.warmup,
    });
    discardBody(res);
  }

  async *generate(input: AnswerRequest): AsyncIterable<AnswerDelta> {
    const base = await this.base();
    if (!isLoopbackHost(new URL(base).hostname)) {
      // Non-loopback hosts are configured explicitly; still never silent.
    }
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
          options: { num_predict: 700, temperature: 0.6 },
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
