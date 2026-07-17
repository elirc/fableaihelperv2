import { describe, expect, it } from 'vitest';
import { CLOUD_MODELS, LOCAL_STT_MODELS, PROVIDERS } from '../../src/shared/catalog';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';
import { isAllowedExternalUrl } from '../../src/main/security/urlPolicy';
import { isAllowedUrl } from '../../src/main/security/http';
import { CEREBRAS_DEFAULT_BASE_URL } from '../../src/main/providers/llm/cerebras';
import { GEMINI_DEFAULT_BASE_URL } from '../../src/main/providers/llm/gemini';
import { GROQ_DEFAULT_BASE_URL } from '../../src/main/providers/llm/groq';
import { OPENROUTER_DEFAULT_BASE_URL } from '../../src/main/providers/llm/openRouter';

describe('provider catalog invariants', () => {
  it('keys the registry by each provider id', () => {
    for (const [key, meta] of Object.entries(PROVIDERS)) {
      expect(meta.id, key).toBe(key);
    }
  });

  it('declares a kind and location for every provider', () => {
    for (const meta of Object.values(PROVIDERS)) {
      expect(['stt', 'llm']).toContain(meta.kind);
      expect(['local', 'cloud']).toContain(meta.location);
    }
  });

  it('requires a disclosure and data-use link for every cloud provider', () => {
    for (const meta of Object.values(PROVIDERS)) {
      if (meta.location === 'cloud') {
        expect(meta.disclosure, meta.id).toBeTruthy();
        expect(meta.dataUseUrl, meta.id).toBeTruthy();
      }
    }
  });

  it('keeps local providers always-free with no cloud disclosure', () => {
    for (const meta of Object.values(PROVIDERS)) {
      if (meta.location === 'local') {
        expect(meta.freePolicy, meta.id).toBe('always-free-local');
        expect(meta.dataUseUrl, meta.id).toBeUndefined();
      }
    }
  });

  it('only links data-use URLs the app is actually allowed to open', () => {
    for (const meta of Object.values(PROVIDERS)) {
      if (meta.dataUseUrl) {
        expect(isAllowedExternalUrl(meta.dataUseUrl), `${meta.id}: ${meta.dataUseUrl}`).toBe(true);
      }
    }
  });

  it('points every credentialId at a catalog provider that owns that key', () => {
    for (const meta of Object.values(PROVIDERS)) {
      if (meta.credentialId) {
        const owner = PROVIDERS[meta.credentialId];
        expect(owner, `${meta.id} -> ${meta.credentialId}`).toBeTruthy();
        expect(owner.location).toBe('cloud');
      }
    }
  });

  it('allowlists the host of every default provider base URL', () => {
    const baseUrls = [
      GROQ_DEFAULT_BASE_URL,
      CEREBRAS_DEFAULT_BASE_URL,
      GEMINI_DEFAULT_BASE_URL,
      OPENROUTER_DEFAULT_BASE_URL,
    ];
    for (const url of baseUrls) {
      expect(isAllowedUrl(url), url).toBe(true);
    }
  });
});

describe('model catalog invariants', () => {
  it('binds every local STT model to a registered STT provider', () => {
    for (const model of LOCAL_STT_MODELS) {
      const provider = PROVIDERS[model.providerId];
      expect(provider, model.id).toBeTruthy();
      expect(provider.kind).toBe('stt');
      expect(provider.location).toBe('local');
    }
  });

  it('has non-empty cloud model ids', () => {
    for (const [key, id] of Object.entries(CLOUD_MODELS)) {
      expect(id.length, key).toBeGreaterThan(0);
    }
  });
});

describe('default settings reference the catalog', () => {
  it('points the default STT provider and model at installed catalog entries', () => {
    const provider = PROVIDERS[DEFAULT_SETTINGS.sttProviderId];
    expect(provider).toBeTruthy();
    expect(provider.kind).toBe('stt');
    expect(LOCAL_STT_MODELS.map((m) => m.id)).toContain(DEFAULT_SETTINGS.sttModelId);
  });

  it('points the default LLM provider at a registered local provider', () => {
    const provider = PROVIDERS[DEFAULT_SETTINGS.llmProviderId];
    expect(provider).toBeTruthy();
    expect(provider.kind).toBe('llm');
    expect(provider.location).toBe('local');
  });
});
