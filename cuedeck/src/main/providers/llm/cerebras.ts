import { CLOUD_MODELS, PROVIDERS } from '../../../shared/catalog';
import { OpenAiCompatibleLlmProvider } from './openAiCompatible';

export const CEREBRAS_DEFAULT_BASE_URL = 'https://api.cerebras.ai/v1';

/**
 * Cerebras inference (free tier: 1M tokens/day at the time of writing).
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
            displayName: `${CLOUD_MODELS.cerebrasModel} (free tier)`,
            providerId: PROVIDERS.cerebras.id,
          },
        ],
      },
      getApiKey,
    );
  }
}
