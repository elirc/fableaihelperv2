import { CLOUD_MODELS, PROVIDERS } from '../../../shared/catalog';
import { DEFAULT_MAX_TOKENS, REASONING_TOKEN_HEADROOM } from '../../../shared/constants';
import type { AnswerRequest } from '../contracts';
import { OpenAiCompatibleLlmProvider } from './openAiCompatible';

export const CEREBRAS_DEFAULT_BASE_URL = 'https://api.cerebras.ai/v1';

/**
 * gpt-oss-120b defaults to medium reasoning effort, which delays the first
 * word; low keeps answers prompt. gemma-4-31b defaults to no reasoning and
 * is left alone. Cerebras rejects unknown fields, so nothing else is sent.
 */
export function cerebrasRequestExtras(
  modelId: string,
  request: Pick<AnswerRequest, 'maxTokens'>,
): Record<string, unknown> {
  if (!modelId.startsWith('gpt-oss-')) return {};
  return {
    reasoning_effort: 'low',
    max_tokens: (request.maxTokens ?? DEFAULT_MAX_TOKENS) + REASONING_TOKEN_HEADROOM,
  };
}

/**
 * Cerebras inference (free trial: 1M tokens/day per model at the time of
 * writing; a verified payment method is required to activate the key).
 * Chosen as the low-latency cloud option — wafer-scale hardware streams
 * tokens roughly an order of magnitude faster than GPU-backed free tiers.
 */
export class CerebrasLlmProvider extends OpenAiCompatibleLlmProvider {
  constructor(getApiKey: () => Promise<string | null>, baseUrl = CEREBRAS_DEFAULT_BASE_URL) {
    super(
      {
        meta: PROVIDERS.cerebras,
        baseUrl,
        providerName: 'Cerebras',
        models: [
          {
            id: CLOUD_MODELS.cerebrasModel,
            displayName: `${CLOUD_MODELS.cerebrasModel} (recommended — best technical answers)`,
            providerId: PROVIDERS.cerebras.id,
          },
          {
            id: CLOUD_MODELS.cerebrasFastModel,
            displayName: `${CLOUD_MODELS.cerebrasFastModel} (fastest, lighter answers)`,
            providerId: PROVIDERS.cerebras.id,
          },
        ],
        requestExtras: cerebrasRequestExtras,
      },
      getApiKey,
    );
  }
}
