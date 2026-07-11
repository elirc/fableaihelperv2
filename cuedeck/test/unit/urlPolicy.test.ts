import { describe, expect, it } from 'vitest';
import { isAllowedExternalUrl } from '../../src/main/security/urlPolicy';

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
});
