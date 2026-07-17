import { describe, expect, it, vi } from 'vitest';
import { CaptureGrant } from '../../src/main/security/captureGrant';
import { isAllowedUrl, isLoopbackHost } from '../../src/main/security/http';
import { CoachError, publicError, toPublicError } from '../../src/shared/errors';
import { PUBLIC_ERROR_CODES } from '../../src/shared/domain';
import { isFreeOpenRouterModel } from '../../src/main/providers/llm/openRouter';

describe('CaptureGrant', () => {
  it('is one-use: a consumed grant does not grant twice', () => {
    const grant = new CaptureGrant();
    grant.arm('session-1');
    expect(grant.consume()).toBe(true);
    expect(grant.consume()).toBe(false);
  });

  it('denies when never armed', () => {
    expect(new CaptureGrant().consume()).toBe(false);
  });

  it('expires after the TTL', () => {
    let now = 1_000;
    const grant = new CaptureGrant(5_000, () => now);
    grant.arm('session-1');
    now += 6_000;
    expect(grant.consume()).toBe(false);
  });

  it('can be disarmed on cancel', () => {
    const grant = new CaptureGrant();
    grant.arm('session-1');
    grant.disarm();
    expect(grant.consume()).toBe(false);
  });

  it('reports an expiry time to the caller', () => {
    vi.useFakeTimers();
    const grant = new CaptureGrant(8_000);
    expect(grant.arm('s').expiresAt).toBe(Date.now() + 8_000);
    vi.useRealTimers();
  });
});

describe('outbound host allowlist', () => {
  it('allows documented provider hosts over https', () => {
    expect(isAllowedUrl('https://api.groq.com/openai/v1/models')).toBe(true);
    expect(isAllowedUrl('https://generativelanguage.googleapis.com/v1beta/models/x')).toBe(true);
    expect(isAllowedUrl('https://openrouter.ai/api/v1/models')).toBe(true);
    expect(isAllowedUrl('https://huggingface.co/onnx-community/whisper-base')).toBe(true);
  });

  it('allows loopback http for Ollama and test fakes', () => {
    expect(isAllowedUrl('http://127.0.0.1:11434/api/tags')).toBe(true);
    expect(isAllowedUrl('http://localhost:8080/x')).toBe(true);
  });

  it('blocks unexpected hosts and protocols', () => {
    expect(isAllowedUrl('https://evil.example.com/exfil')).toBe(false);
    expect(isAllowedUrl('http://api.groq.com/downgrade')).toBe(false);
    expect(isAllowedUrl('ftp://127.0.0.1/x')).toBe(false);
    expect(isAllowedUrl('not a url')).toBe(false);
  });

  it('recognizes loopback hosts precisely', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.9.9.9')).toBe(true);
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
    expect(isLoopbackHost('evil-localhost.com')).toBe(false);
  });
});

describe('public error mapping', () => {
  it('carries structured errors through CoachError', () => {
    const err = new CoachError('MODEL_NOT_INSTALLED', 'whisper-base missing');
    expect(toPublicError(err)).toMatchObject({
      code: 'MODEL_NOT_INSTALLED',
      retryable: false,
      action: 'download-model',
      detail: 'whisper-base missing',
    });
  });

  it('maps aborts to cancellation', () => {
    expect(toPublicError(new DOMException('aborted', 'AbortError')).code).toBe('REQUEST_CANCELLED');
  });

  it('maps timeouts to PROVIDER_TIMEOUT', () => {
    expect(toPublicError(new DOMException('timeout', 'TimeoutError')).code).toBe(
      'PROVIDER_TIMEOUT',
    );
  });

  it('maps unknown values safely', () => {
    expect(toPublicError('boom').code).toBe('UNKNOWN');
    expect(publicError('UNKNOWN').retryable).toBe(true);
  });

  it('treats plain errors that merely mention aborting as cancellation', () => {
    expect(toPublicError(new Error('The operation was aborted')).code).toBe('REQUEST_CANCELLED');
  });

  it('preserves the message of generic errors as detail on UNKNOWN', () => {
    const mapped = toPublicError(new Error('ECONNRESET while streaming'));
    expect(mapped.code).toBe('UNKNOWN');
    expect(mapped.detail).toBe('ECONNRESET while streaming');
    expect(mapped.action).toBe('open-diagnostics');
  });

  it('stringifies non-error throws into detail', () => {
    expect(toPublicError(null).detail).toBe('null');
    expect(toPublicError(42).detail).toBe('42');
  });

  it('has a user-facing template for every public error code', () => {
    for (const code of PUBLIC_ERROR_CODES) {
      const err = publicError(code);
      expect(err.code).toBe(code);
      expect(err.message.length, code).toBeGreaterThan(0);
      expect(typeof err.retryable).toBe('boolean');
    }
  });

  it('marks credential problems non-retryable with a replace-key action', () => {
    for (const code of ['CREDENTIAL_MISSING', 'CREDENTIAL_REJECTED'] as const) {
      const err = publicError(code);
      expect(err.retryable, code).toBe(false);
      expect(err.action, code).toBe('replace-key');
    }
  });

  it('never copies the internal detail into the user-facing message', () => {
    const err = new CoachError('PROVIDER_UNAVAILABLE', 'gsk_secret_in_detail');
    expect(err.public.message).not.toContain('gsk_secret_in_detail');
    expect(err.public.message).toBe(publicError('PROVIDER_UNAVAILABLE').message);
  });
});

describe('OpenRouter free-model policy', () => {
  it('accepts :free models with zero pricing', () => {
    expect(
      isFreeOpenRouterModel({ id: 'meta/llama:free', pricing: { prompt: '0', completion: 0 } }),
    ).toBe(true);
    expect(isFreeOpenRouterModel({ id: 'openrouter/free' })).toBe(true);
  });

  it('rejects paid or ambiguous models', () => {
    expect(isFreeOpenRouterModel({ id: 'meta/llama' })).toBe(false);
    expect(isFreeOpenRouterModel({ id: 'meta/llama:free', pricing: { prompt: '0.001' } })).toBe(
      false,
    );
  });
});
