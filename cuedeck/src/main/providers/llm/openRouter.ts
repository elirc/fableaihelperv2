import { z } from 'zod';
import { CLOUD_MODELS, PROVIDERS } from '../../../shared/catalog';
import { TIMEOUTS } from '../../../shared/constants';
import type { ModelSummary, ProviderProbe } from '../../../shared/domain';
import { CoachError } from '../../../shared/errors';
import { allowlistedFetch, discardBody } from '../../security/http';
import { OpenAiCompatibleLlmProvider } from './openAiCompatible';

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

/**
 * OpenAI-compatible transport with OpenRouter-specific model policy: the
 * model list is discovered live and filtered to free models only.
 */
export class OpenRouterProvider extends OpenAiCompatibleLlmProvider {
  private cachedModels: ModelSummary[] | null = null;

  constructor(getApiKey: () => Promise<string | null>, baseUrl = OPENROUTER_DEFAULT_BASE_URL) {
    super(
      {
        meta: PROVIDERS.openrouter,
        baseUrl,
        providerName: 'OpenRouter',
        models: [],
        extraHeaders: {
          'http-referer': 'https://github.com/cuedeck/cuedeck',
          'x-title': 'CueDeck',
        },
        assertModelAllowed: (modelId) => {
          if (modelId !== CLOUD_MODELS.openRouterDefaultModel && !modelId.endsWith(':free')) {
            throw new CoachError(
              'PROVIDER_UNAVAILABLE',
              'only free OpenRouter models are permitted',
            );
          }
        },
      },
      getApiKey,
    );
  }

  override async probe(signal: AbortSignal): Promise<ProviderProbe> {
    const probe = await super.probe(signal);
    if (probe.status === 'ready') {
      probe.models = await this.listModels(signal).catch(() => undefined);
    }
    return probe;
  }

  override async listModels(signal: AbortSignal): Promise<ModelSummary[]> {
    try {
      const res = await allowlistedFetch(`${this.descriptor.baseUrl.replace(/\/+$/, '')}/models`, {
        signal,
        timeoutMs: TIMEOUTS.probe,
      });
      if (!res.ok) {
        discardBody(res);
        throw new CoachError('PROVIDER_UNAVAILABLE', `OpenRouter responded ${res.status}`);
      }
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
}
