import { describe, expect, it } from 'vitest';
import { isAllowedExternalUrl } from '../../src/main/security/urlPolicy';
import { EXTERNAL_LINK_ALLOWLIST } from '../../src/shared/constants';

describe('isAllowedExternalUrl', () => {
  it('allows allowlisted https links', () => {
    expect(isAllowedExternalUrl('https://ollama.com/download')).toBe(true);
    expect(isAllowedExternalUrl('https://console.groq.com/keys')).toBe(true);
    expect(isAllowedExternalUrl('https://openrouter.ai/keys')).toBe(true);
  });

  it('blocks non-https, lookalike hosts, and arbitrary paths on other hosts', () => {
    expect(isAllowedExternalUrl('http://ollama.com/download')).toBe(false);
    expect(isAllowedExternalUrl('https://ollama.com.evil.com/download')).toBe(false);
    expect(isAllowedExternalUrl('https://example.com/')).toBe(false);
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedExternalUrl('file:///C:/Windows')).toBe(false);
    expect(isAllowedExternalUrl('not a url')).toBe(false);
  });

  it('accepts every allowlist entry verbatim (self-consistency)', () => {
    for (const url of EXTERNAL_LINK_ALLOWLIST) {
      expect(isAllowedExternalUrl(url), url).toBe(true);
    }
  });

  it('scopes path-restricted hosts: other paths on the same host are blocked', () => {
    expect(isAllowedExternalUrl('https://console.groq.com/')).toBe(false);
    expect(isAllowedExternalUrl('https://console.groq.com/settings/billing')).toBe(false);
    expect(isAllowedExternalUrl('https://ai.google.dev/')).toBe(false);
  });

  it('allows sub-paths under an allowlisted prefix', () => {
    expect(isAllowedExternalUrl('https://ollama.com/download/windows')).toBe(true);
    expect(isAllowedExternalUrl('https://huggingface.co/onnx-community/whisper-base')).toBe(true);
  });

  it('is not fooled by userinfo tricks or trailing-dot hosts', () => {
    expect(isAllowedExternalUrl('https://ollama.com@evil.com/download')).toBe(false);
    expect(isAllowedExternalUrl('https://ollama.com./download')).toBe(false);
  });

  it('normalizes scheme and host case', () => {
    expect(isAllowedExternalUrl('HTTPS://OLLAMA.COM/download')).toBe(true);
  });
});
