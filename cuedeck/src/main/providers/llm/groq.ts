import { CLOUD_MODELS, PROVIDERS } from '../../../shared/catalog';
import { OpenAiCompatibleLlmProvider } from './openAiCompatible';

export const GROQ_DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';

export class GroqLlmProvider extends OpenAiCompatibleLlmProvider {
  constructor(getApiKey: () => Promise<string | null>, baseUrl = GROQ_DEFAULT_BASE_URL) {
    super(
      {
        meta: PROVIDERS.groq,
        baseUrl,
        providerName: 'Groq',
        models: [
          {
            id: CLOUD_MODELS.groqLlmModel,
            displayName: `${CLOUD_MODELS.groqLlmModel} (free plan)`,
            providerId: PROVIDERS.groq.id,
          },
        ],
      },
      getApiKey,
    );
  }
}
