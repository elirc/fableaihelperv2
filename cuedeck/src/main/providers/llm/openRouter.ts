import { z } from 'zod';
import { CLOUD_MODELS, PROVIDERS } from '../../../shared/catalog';
import { TIMEOUTS } from '../../../shared/constants';
import type { AnswerDelta, ModelSummary, ProviderProbe } from '../../../shared/domain';
import { CoachError } from '../../../shared/errors';
import { allowlistedFetch } from '../../security/http';
import type { AnswerRequest, LlmProvider } from '../contracts';
import { probeOpenAiCompatible, streamChatCompletions } from './openAiCompatible';

export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

const modelsSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        pricing: z
          .object({
            prompt: z.union([z.string(), z.number()]).optional(),
            completion: z.union([z.string(), z.number()]).optional(),
          })
          .optional(),
      }),
    )
    .default([]),
});

/** True when a model is free to use (spec §12.5). */
export function isFreeOpenRouterModel(model: {
  id: string;
  pricing?: { prompt?: string | number; completion?: string | number };
}): boolean {
  if (model.id === CLOUD_MODELS.openRouterDefaultModel) return true;
  if (!model.id.endsWith(':free')) return false;
  const prices = [model.pricing?.prompt, model.pricing?.completion];
  return prices.every((p) => p === undefined || Number(p) === 0);
}

export class OpenRouterProvider implements LlmProvider {
  readonly meta = PROVIDERS.openrouter;
  private cachedModels: ModelSummary[] | null = null;

  constructor(
    private readonly getApiKey: () => Promise<string | null>,
    private readonly baseUrl: string = OPENROUTER_DEFAULT_BASE_URL,
  ) {}

  async probe(signal: AbortSignal): Promise<ProviderProbe> {
    const probe = await probeOpenAiCompatible({
      baseUrl: this.baseUrl,
      apiKey: await this.getApiKey(),
      providerName: 'OpenRouter',
      meta: this.meta,
      signal,
    });
    if (probe.status === 'ready') {
      probe.models = await this.listModels(signal).catch(() => undefined);
    }
    return probe;
  }

  async listModels(signal: AbortSignal): Promise<ModelSummary[]> {
    try {
      const res = await allowlistedFetch(`${this.baseUrl.replace(/\/+$/, '')}/models`, {
        signal,
        timeoutMs: TIMEOUTS.probe,
      });
      if (!res.ok)
        throw new CoachError('PROVIDER_UNAVAILABLE', `OpenRouter responded ${res.status}`);
      const parsed = modelsSchema.parse(await res.json());
      const free = parsed.data.filter(isFreeOpenRouterModel).map((m) => ({
        id: m.id,
        displayName: m.name ?? m.id,
        providerId: this.meta.id,
      }));
      this.cachedModels = [
        {
          id: CLOUD_MODELS.openRouterDefaultModel,
          displayName: 'OpenRouter free router (auto-selects a free model)',
          providerId: this.meta.id,
        },
        ...free.filter((m) => m.id !== CLOUD_MODELS.openRouterDefaultModel),
      ];
      return this.cachedModels;
    } catch (err) {
      if (this.cachedModels) return this.cachedModels; // cached fallback (spec §12.5)
      throw err;
    }
  }

  async *generate(input: AnswerRequest): AsyncIterable<AnswerDelta> {
    const apiKey = await this.getApiKey();
    if (!apiKey) throw new CoachError('CREDENTIAL_MISSING', 'OpenRouter API key not configured');
    if (input.modelId !== CLOUD_MODELS.openRouterDefaultModel && !input.modelId.endsWith(':free')) {
      throw new CoachError('PROVIDER_UNAVAILABLE', 'only free OpenRouter models are permitted');
    }
    yield* streamChatCompletions({
      baseUrl: this.baseUrl,
      apiKey,
      providerName: 'OpenRouter',
      extraHeaders: {
        'http-referer': 'https://github.com/cuedeck/cuedeck',
        'x-title': 'CueDeck',
      },
      request: input,
    });
  }
}
