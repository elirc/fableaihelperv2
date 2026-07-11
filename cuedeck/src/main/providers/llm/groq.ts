import { CLOUD_MODELS, PROVIDERS } from '../../../shared/catalog';
import type { AnswerDelta, ModelSummary, ProviderProbe } from '../../../shared/domain';
import { CoachError } from '../../../shared/errors';
import type { AnswerRequest, LlmProvider } from '../contracts';
import { probeOpenAiCompatible, streamChatCompletions } from './openAiCompatible';

export const GROQ_DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';

export class GroqLlmProvider implements LlmProvider {
  readonly meta = PROVIDERS.groq;

  constructor(
    private readonly getApiKey: () => Promise<string | null>,
    private readonly baseUrl: string = GROQ_DEFAULT_BASE_URL,
  ) {}

  async probe(signal: AbortSignal): Promise<ProviderProbe> {
    return probeOpenAiCompatible({
      baseUrl: this.baseUrl,
      apiKey: await this.getApiKey(),
      providerName: 'Groq',
      meta: this.meta,
      signal,
    });
  }

  async listModels(): Promise<ModelSummary[]> {
    return [
      {
        id: CLOUD_MODELS.groqLlmModel,
        displayName: `${CLOUD_MODELS.groqLlmModel} (free plan)`,
        providerId: this.meta.id,
      },
    ];
  }

  async *generate(input: AnswerRequest): AsyncIterable<AnswerDelta> {
    const apiKey = await this.getApiKey();
    if (!apiKey) throw new CoachError('CREDENTIAL_MISSING', 'Groq API key not configured');
    yield* streamChatCompletions({
      baseUrl: this.baseUrl,
      apiKey,
      providerName: 'Groq',
      request: input,
    });
  }
}
