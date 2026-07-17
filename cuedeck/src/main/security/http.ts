import { ALLOWED_HOSTS } from '../../shared/constants';
import { CoachError } from '../../shared/errors';

/**
 * Outbound HTTP policy for the privileged process. Every provider adapter
 * goes through `allowlistedFetch`; anything not on the allowlist (or
 * loopback, for Ollama and test fakes) is refused before a socket opens.
 */

export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    // Whole 127.0.0.0/8 block, but only literal IPv4 addresses — a DNS name
    // like "127.evil.com" must not count as loopback.
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

export function isAllowedUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol === 'http:') return isLoopbackHost(url.hostname);
  if (url.protocol !== 'https:') return false;
  return (
    isLoopbackHost(url.hostname) || (ALLOWED_HOSTS as readonly string[]).includes(url.hostname)
  );
}

export interface FetchOptions extends RequestInit {
  timeoutMs?: number;
}

/** Fetch with host allowlisting and a stage timeout merged into the caller's signal. */
export async function allowlistedFetch(url: string, options: FetchOptions = {}): Promise<Response> {
  if (!isAllowedUrl(url)) {
    throw new CoachError('PROVIDER_UNAVAILABLE', `host not allowed: ${safeHost(url)}`);
  }
  const { timeoutMs, signal, ...rest } = options;
  const signals: AbortSignal[] = [];
  if (signal) signals.push(signal);
  if (timeoutMs) signals.push(AbortSignal.timeout(timeoutMs));
  const merged = signals.length > 0 ? AbortSignal.any(signals) : undefined;
  try {
    return await fetch(url, { ...rest, signal: merged, redirect: 'follow' });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new CoachError('PROVIDER_TIMEOUT', `request to ${safeHost(url)} timed out`);
    }
    throw err;
  }
}

/**
 * Release a response whose body will never be read (error statuses, probes)
 * so the pooled socket is freed immediately instead of on GC.
 */
export function discardBody(res: Response): void {
  void res.body?.cancel().catch(() => undefined);
}

function safeHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return 'invalid-url';
  }
}
