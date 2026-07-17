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

  it('redacts a token query param without eating the rest of the URL', () => {
    const out = redactSecrets('https://x.example/cb?token=abcdef123456&state=ok');
    expect(out).toBe('https://x.example/cb?token=[REDACTED]&state=ok');
  });

  it('redacts JSON-quoted authorization headers', () => {
    const out = redactSecrets('{"Authorization": "Bearer sk-abcdefghijklmnop"}');
    expect(out).not.toContain('sk-abcdefghijklmnop');
  });

  it('redacts every occurrence in multi-line text', () => {
    const out = redactSecrets(
      'first gsk_aaaaaaaaaaaaaaa here\nthen api_key=bbbbbbbbbbbb\nand gsk_ccccccccccccccc last',
    );
    expect(out).not.toContain('gsk_aaaaaaaaaaaaaaa');
    expect(out).not.toContain('bbbbbbbbbbbb');
    expect(out).not.toContain('gsk_ccccccccccccccc');
  });

  it('preserves surrounding unicode while redacting', () => {
    const out = redactSecrets('clé ✓ gsk_abcdefghijklm — fin');
    expect(out).toBe('clé ✓ [REDACTED] — fin');
  });

  it('redacts quoted password fields but keeps the closing quote', () => {
    const out = redactSecrets('{"password": "hunter2secret"}');
    expect(out).toBe('{"password": "[REDACTED]"}');
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

  it('matches secret key names case-insensitively at any depth', () => {
    const out = redactDeep({
      a: [{ b: { PASSWORD: 'hunter2', Token: 'tk', API_KEY: 'k' } }],
    });
    expect(out.a[0].b.PASSWORD).toBe('[REDACTED]');
    expect(out.a[0].b.Token).toBe('[REDACTED]');
    expect(out.a[0].b.API_KEY).toBe('[REDACTED]');
  });

  it('replaces secret-named fields even when the value is not a string', () => {
    const out = redactDeep({ secret: { inner: 'gsk_abcdefghijklm' }, token: 42 });
    expect(out.secret).toBe('[REDACTED]');
    expect(out.token).toBe('[REDACTED]');
  });

  it('preserves non-string primitives and null', () => {
    const input = { count: 3, ok: true, missing: null, ratio: 0.5 };
    expect(redactDeep(input)).toEqual(input);
  });

  it('does not mutate the input structure', () => {
    const input = { nested: { apiKey: 'raw-value', note: 'plain' } };
    const out = redactDeep(input);
    expect(input.nested.apiKey).toBe('raw-value');
    expect(out).not.toBe(input);
    expect(out.nested).not.toBe(input.nested);
  });

  it('redacts provider keys embedded in array-of-string logs', () => {
    const out = redactDeep({
      logs: ['request to https://api?key=AIzaSyA1234567890abcdefghijk failed', 'plain line'],
    });
    expect(out.logs[0]).not.toContain('AIzaSyA1234567890abcdefghijk');
    expect(out.logs[1]).toBe('plain line');
  });
});
