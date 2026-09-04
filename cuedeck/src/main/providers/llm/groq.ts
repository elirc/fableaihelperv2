import { CLOUD_MODELS, PROVIDERS } from '../../../shared/catalog';
import { DEFAULT_MAX_TOKENS, REASONING_TOKEN_HEADROOM } from '../../../shared/constants';
import type { AnswerRequest } from '../contracts';
import { OpenAiCompatibleLlmProvider } from './openAiCompatible';

export const GROQ_DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';

/**
 * gpt-oss models reason before answering by default (medium effort), which
 * adds seconds before the first spoken word and burns free-plan tokens. Low
 * effort keeps the answer quality for interview-length responses; reasoning
 * text is excluded from the stream so only the answer reaches the card.
 * Groq only accepts these fields for the gpt-oss family.
 */
export function groqRequestExtras(
  modelId: string,
  request: Pick<AnswerRequest, 'maxTokens'>,
): Record<string, unknown> {
  if (!modelId.startsWith('openai/gpt-oss-')) return {};
  return {
    reasoning_effort: 'low',
    include_reasoning: false,
    max_tokens: (request.maxTokens ?? DEFAULT_MAX_TOKENS) + REASONING_TOKEN_HEADROOM,
  };
}

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
            displayName: `${CLOUD_MODELS.groqLlmModel} (recommended — best technical answers)`,
            providerId: PROVIDERS.groq.id,
          },
          {
            id: CLOUD_MODELS.groqLlmFastModel,
            displayName: `${CLOUD_MODELS.groqLlmFastModel} (fastest, lighter answers)`,
            providerId: PROVIDERS.groq.id,
          },
        ],
        requestExtras: groqRequestExtras,
      },
      getApiKey,
    );
  }
}
