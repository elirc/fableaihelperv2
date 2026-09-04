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

/**
 * Hosts that can only be reached from inside the user's own network:
 * loopback, RFC 1918 / link-local / ULA address literals, and mDNS or
 * single-label LAN names. A user-confirmed "remote" Ollama must live here;
 * a public address can never be unlocked from settings.
 */
export function isPrivateNetworkHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isLoopbackHost(host)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (host.includes(':')) return /^(fc|fd|fe[89ab])/.test(host);
  if (!host.includes('.')) return true;
  return /\.(local|lan|home|internal|localdomain)$/.test(host);
}

/**
 * `allowedOrigins` are exact `scheme://host[:port]` origins the caller has
 * been explicitly configured with — the user-confirmed remote Ollama server
 * — and are the only way plain http reaches a non-loopback host. Even then
 * the host must be on a private network.
 */
export function isAllowedUrl(rawUrl: string, allowedOrigins: readonly string[] = []): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (allowedOrigins.includes(url.origin) && isPrivateNetworkHost(url.hostname)) return true;
  if (url.protocol === 'http:') return isLoopbackHost(url.hostname);
  return (
    isLoopbackHost(url.hostname) || (ALLOWED_HOSTS as readonly string[]).includes(url.hostname)
  );
}

export interface FetchOptions extends RequestInit {
  timeoutMs?: number;
  /** Extra exact origins permitted for this call; see `isAllowedUrl`. */
  allowedOrigins?: readonly string[];
}

/** Fetch with host allowlisting and a stage timeout merged into the caller's signal. */
export async function allowlistedFetch(url: string, options: FetchOptions = {}): Promise<Response> {
  const { timeoutMs, signal, allowedOrigins, ...rest } = options;
  if (!isAllowedUrl(url, allowedOrigins)) {
    throw new CoachError('PROVIDER_UNAVAILABLE', `host not allowed: ${safeHost(url)}`);
  }
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
