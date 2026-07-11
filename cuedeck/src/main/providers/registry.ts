import type { ProviderMeta } from '../../shared/domain';
import { CoachError } from '../../shared/errors';
import type { LlmProvider, SttProvider } from './contracts';

/** Registry mapping provider IDs to adapter instances (spec §11.1). */
export class ProviderRegistry {
  private readonly stt = new Map<string, SttProvider>();
  private readonly llm = new Map<string, LlmProvider>();

  registerStt(provider: SttProvider): void {
    this.stt.set(provider.meta.id, provider);
  }

  registerLlm(provider: LlmProvider): void {
    this.llm.set(provider.meta.id, provider);
  }

  getStt(id: string): SttProvider {
    const provider = this.stt.get(id);
    if (!provider) throw new CoachError('PROVIDER_UNAVAILABLE', `unknown STT provider ${id}`);
    return provider;
  }

  getLlm(id: string): LlmProvider {
    const provider = this.llm.get(id);
    if (!provider) throw new CoachError('PROVIDER_UNAVAILABLE', `unknown LLM provider ${id}`);
    return provider;
  }

  getAny(id: string): SttProvider | LlmProvider {
    return this.stt.get(id) ?? this.getLlm(id);
  }

  list(): ProviderMeta[] {
    return [...this.stt.values(), ...this.llm.values()].map((p) => p.meta);
  }
}
