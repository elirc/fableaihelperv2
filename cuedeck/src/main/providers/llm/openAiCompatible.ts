import { z } from 'zod';
import { TIMEOUTS } from '../../../shared/constants';
import type { AnswerDelta, ProviderProbe, ProviderMeta } from '../../../shared/domain';
import { CoachError } from '../../../shared/errors';
import { SseParser } from '../../../shared/streaming';
import { allowlistedFetch } from '../../security/http';
import { bodyChunks, type AnswerRequest } from '../contracts';

const chunkSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z.object({ content: z.string().nullable().optional() }).optional(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .default([]),
});

export function mapHttpStatus(status: number, providerName: string): CoachError {
  if (status === 401 || status === 403) {
    return new CoachError(
      'CREDENTIAL_REJECTED',
      `${providerName} rejected the API key (${status})`,
    );
  }
  if (status === 429) {
    return new CoachError('PROVIDER_RATE_LIMITED', `${providerName} rate limit reached`);
  }
  if (status === 404) {
    return new CoachError('PROVIDER_UNAVAILABLE', `${providerName} model not found`);
  }
  return new CoachError('PROVIDER_UNAVAILABLE', `${providerName} responded ${status}`);
}

/**
 * Streaming chat completion against an OpenAI-compatible endpoint
 * (Groq, OpenRouter). Emits monotonic sequence numbers; honors a single
 * short Retry-After on 429 while the caller is still waiting (spec §12.3).
 */
export async function* streamChatCompletions(options: {
  baseUrl: string;
  path?: string;
  apiKey: string;
  providerName: string;
  extraHeaders?: Record<string, string>;
  request: AnswerRequest;
}): AsyncIterable<AnswerDelta> {
  const { baseUrl, apiKey, providerName, request } = options;
  const url = `${baseUrl.replace(/\/+$/, '')}${options.path ?? '/chat/completions'}`;
  const doFetch = () =>
    allowlistedFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...options.extraHeaders,
      },
      body: JSON.stringify({
        model: request.modelId,
        stream: true,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
      }),
      signal: request.signal,
      timeoutMs: TIMEOUTS.llmTotal,
    });

  let res = await doFetch();
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 10) {
      await abortableDelay(retryAfter * 1000, request.signal);
      res = await doFetch();
    }
  }
  if (!res.ok) throw mapHttpStatus(res.status, providerName);

  const parser = new SseParser();
  let sequence = 0;
  const handle = (data: string): AnswerDelta | null => {
    if (data.trim() === '[DONE]') return null;
    let obj: unknown;
    try {
      obj = JSON.parse(data);
    } catch {
      return null; // tolerate comment/keepalive frames
    }
    const parsed = chunkSchema.safeParse(obj);
    if (!parsed.success) return null;
    const text = parsed.data.choices[0]?.delta?.content ?? '';
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

export async function probeOpenAiCompatible(options: {
  baseUrl: string;
  apiKey: string | null;
  providerName: string;
  meta: ProviderMeta;
  signal: AbortSignal;
  extraHeaders?: Record<string, string>;
}): Promise<ProviderProbe> {
  if (!options.apiKey) {
    return { providerId: options.meta.id, status: 'missing-credential' };
  }
  const started = Date.now();
  try {
    const res = await allowlistedFetch(`${options.baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { authorization: `Bearer ${options.apiKey}`, ...options.extraHeaders },
      signal: options.signal,
      timeoutMs: TIMEOUTS.probe,
    });
    if (res.status === 401 || res.status === 403) {
      return {
        providerId: options.meta.id,
        status: 'missing-credential',
        detail: 'API key rejected',
      };
    }
    if (res.status === 429) {
      return { providerId: options.meta.id, status: 'quota-limited' };
    }
    if (!res.ok) {
      return {
        providerId: options.meta.id,
        status: 'unknown-failure',
        detail: `HTTP ${res.status}`,
      };
    }
    return { providerId: options.meta.id, status: 'ready', latencyMs: Date.now() - started };
  } catch (err) {
    return {
      providerId: options.meta.id,
      status: 'unreachable',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
