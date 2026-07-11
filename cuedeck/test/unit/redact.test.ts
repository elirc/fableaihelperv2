import { describe, expect, it } from 'vitest';
import { redactDeep, redactSecrets } from '../../src/shared/redact';

describe('redactSecrets', () => {
  it('redacts bearer tokens', () => {
    expect(redactSecrets('Authorization: Bearer gsk_abc123def456ghi789')).not.toContain(
      'gsk_abc123def456ghi789',
    );
  });

  it('redacts Groq-style keys anywhere in text', () => {
    const out = redactSecrets('request failed for key gsk_1234567890abcdef try again');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('gsk_1234567890abcdef');
  });

  it('redacts OpenRouter keys', () => {
    expect(redactSecrets('sk-or-v1-aaaabbbbccccdddd')).not.toContain('sk-or-v1-aaaabbbbccccdddd');
  });

  it('redacts Google API keys', () => {
    expect(redactSecrets('url?key=AIzaSyA1234567890abcdefghijk')).not.toContain(
      'AIzaSyA1234567890abcdefghijk',
    );
  });

  it('redacts key/token JSON fields', () => {
    const out = redactSecrets('{"api_key":"supersecretvalue1"}');
    expect(out).not.toContain('supersecretvalue1');
  });

  it('leaves ordinary text alone', () => {
    const text = 'The provider responded 429; retry in 3 seconds.';
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('redactDeep', () => {
  it('redacts secret-named fields and nested strings', () => {
    const out = redactDeep({
      authorization: 'Bearer abc',
      nested: { apiKey: 'xyz', note: 'token=abcdef123456' },
      list: ['gsk_1234567890abcdef'],
    });
    expect(out.authorization).toBe('[REDACTED]');
    expect(out.nested.apiKey).toBe('[REDACTED]');
    expect(out.nested.note).not.toContain('abcdef123456');
    expect(out.list[0]).toBe('[REDACTED]');
  });
});
