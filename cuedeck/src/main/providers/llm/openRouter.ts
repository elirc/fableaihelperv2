import { z } from 'zod';
import { CLOUD_MODELS, PROVIDERS } from '../../../shared/catalog';
import { TIMEOUTS } from '../../../shared/constants';
import type { AnswerDelta, ModelSummary, ProviderProbe } from '../../../shared/domain';
import { CoachError } from '../../../shared/errors';
import { allowlistedFetch, discardBody } from '../../security/http';
import type { AnswerRequest } from '../contracts';
import { OpenAiCompatibleLlmProvider } from './openAiCompatible';

export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/** Paid models listed when the opt-in is on; keeps the picker usable. */
export const OPENROUTER_MAX_PAID_MODELS = 60;

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

type OpenRouterModel = z.infer<typeof modelsSchema>['data'][number];

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

/** OpenRouter prices are USD per token; show them per million tokens. */
function perMillion(price: string | number | undefined): number | null {
  if (price === undefined) return null;
  const n = Number(price);
  if (!Number.isFinite(n) || n < 0) return null; // -1 marks variable pricing
  return n * 1_000_000;
}

function formatPrice(perM: number): string {
  return perM < 1 ? `$${perM.toFixed(2)}` : `$${perM.toFixed(perM < 10 ? 1 : 0)}`;
}

/**
 * Paid models sorted cheapest-first by completion price, with the price
 * shown in the display name so the cost is visible at selection time.
 */
export function describePaidModels(models: OpenRouterModel[], limit: number): ModelSummary[] {
  return models
    .filter((m) => !isFreeOpenRouterModel(m))
    .map((m) => ({
      model: m,
      promptPerM: perMillion(m.pricing?.prompt),
      completionPerM: perMillion(m.pricing?.completion),
    }))
    .filter((m) => m.promptPerM !== null && m.completionPerM !== null)
    .sort((a, b) => (a.completionPerM as number) - (b.completionPerM as number))
    .slice(0, limit)
    .map(({ model, promptPerM, completionPerM }) => ({
      id: model.id,
      displayName: `${model.name ?? model.id} — ${formatPrice(promptPerM as number)} in / ${formatPrice(completionPerM as number)} out per 1M tokens`,
      providerId: PROVIDERS.openrouter.id,
    }));
}

/**
 * OpenAI-compatible transport with OpenRouter-specific model policy: the
 * model list is discovered live and filtered to free models only — unless
 * the user has explicitly opted into paid models (billed to their own
 * OpenRouter credits; spend limits are set on the key at openrouter.ai).
 */
export class OpenRouterProvider extends OpenAiCompatibleLlmProvider {
  private cachedFree: ModelSummary[] | null = null;
  private cachedPaid: ModelSummary[] | null = null;

  constructor(
    getApiKey: () => Promise<string | null>,
    baseUrl = OPENROUTER_DEFAULT_BASE_URL,
    private readonly getAllowPaid: () => Promise<boolean> = async () => false,
  ) {
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
      },
      getApiKey,
    );
  }

  private isAllowedId(modelId: string, allowPaid: boolean): boolean {
    if (allowPaid) return true;
    return modelId === CLOUD_MODELS.openRouterDefaultModel || modelId.endsWith(':free');
  }

  override async *generate(input: AnswerRequest): AsyncIterable<AnswerDelta> {
    if (!this.isAllowedId(input.modelId, await this.getAllowPaid())) {
      throw new CoachError(
        'PROVIDER_UNAVAILABLE',
        'only free OpenRouter models are permitted unless paid models are enabled in Preferences',
      );
    }
    yield* super.generate(input);
  }

  override async probe(signal: AbortSignal): Promise<ProviderProbe> {
    const probe = await super.probe(signal);
    if (probe.status === 'ready') {
      probe.models = await this.listModels(signal).catch(() => undefined);
    }
    return probe;
  }

  override async listModels(signal: AbortSignal): Promise<ModelSummary[]> {
    const allowPaid = await this.getAllowPaid();
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
      this.cachedFree = [
        {
          id: CLOUD_MODELS.openRouterDefaultModel,
          displayName: 'OpenRouter free router (auto-selects a free model)',
          providerId: this.meta.id,
        },
        ...free.filter((m) => m.id !== CLOUD_MODELS.openRouterDefaultModel),
      ];
      this.cachedPaid = describePaidModels(parsed.data, OPENROUTER_MAX_PAID_MODELS);
    } catch (err) {
      if (!this.cachedFree) throw err; // cached fallback (spec §12.5)
    }
    const free = this.cachedFree ?? [];
    return allowPaid ? [...free, ...(this.cachedPaid ?? [])] : free;
  }
}
