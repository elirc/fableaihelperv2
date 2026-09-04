import { z } from 'zod';
import { PROVIDERS } from '../../../shared/catalog';
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  OLLAMA_KEEP_ALIVE,
  OLLAMA_NUM_CTX,
  TIMEOUTS,
} from '../../../shared/constants';
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

/** Ollama's own words for a request whose `model` field is empty or absent. */
const MODEL_REQUIRED = /model\s+(is\s+)?(required|missing|empty)|(missing|empty|no)\s+model/i;

/** Longest slice of a provider error body kept in a CoachError detail. */
const ERROR_DETAIL_CAP = 200;

/**
 * Read the `error` string Ollama puts in a non-OK JSON body ("model is
 * required"), falling back to the raw text. The status alone cannot tell an
 * unconfigured model from a real outage. Consumes the body, which also
 * releases the socket — callers must not `discardBody` afterwards.
 */
async function errorDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = (await res.text()).trim();
  } catch {
    return '';
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const error = (parsed as { error?: unknown } | null)?.error;
    // A JSON body without an `error` string adds nothing to the status.
    return typeof error === 'string' ? error.slice(0, ERROR_DETAIL_CAP) : '';
  } catch {
    // Not JSON (a proxy's HTML error page); the raw text is the best detail.
    return raw.slice(0, ERROR_DETAIL_CAP);
  }
}

/** Map a non-OK /api/chat response to the error the user can act on. */
function chatError(status: number, detail: string, modelId: string): CoachError {
  if (status === 404) {
    return new CoachError('MODEL_NOT_INSTALLED', `model ${modelId} is not installed in Ollama`);
  }
  if (status === 400 && MODEL_REQUIRED.test(detail)) {
    return new CoachError('MODEL_NOT_SELECTED', `Ollama responded 400: ${detail}`);
  }
  return new CoachError(
    'PROVIDER_UNAVAILABLE',
    detail ? `Ollama responded ${status}: ${detail}` : `Ollama responded ${status}`,
  );
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

  /**
   * The configured server is the one origin plain http may reach off
   * loopback. A non-loopback address only gets into settings after the
   * user confirmed in Preferences that prompts and profile data will leave
   * the device, so the allowlist admits exactly that origin and nothing
   * else (a redirect elsewhere still fails the host check).
   */
  private allowedOrigins(base: string): string[] {
    try {
      return [new URL(base).origin];
    } catch {
      return [];
    }
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
    const base = await this.base();
    const res = await allowlistedFetch(`${base}/api/tags`, {
      signal,
      timeoutMs: TIMEOUTS.probe,
      allowedOrigins: this.allowedOrigins(base),
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
    const base = await this.base();
    const res = await allowlistedFetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      timeoutMs: TIMEOUTS.warmup,
      allowedOrigins: this.allowedOrigins(base),
    });
    if (!res.ok) throw chatError(res.status, await errorDetail(res), modelId);
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
            num_predict: input.maxTokens ?? DEFAULT_MAX_TOKENS,
            temperature: input.temperature ?? DEFAULT_TEMPERATURE,
          },
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.user },
          ],
        }),
        signal: input.signal,
        timeoutMs: TIMEOUTS.llmTotal,
        allowedOrigins: this.allowedOrigins(base),
      });
    } catch (err) {
      if (err instanceof CoachError) throw err;
      if (err instanceof Error && err.name === 'AbortError') throw err;
      throw new CoachError('LOCAL_PROVIDER_UNREACHABLE', 'could not connect to Ollama');
    }
    if (!res.ok) throw chatError(res.status, await errorDetail(res), input.modelId);
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
