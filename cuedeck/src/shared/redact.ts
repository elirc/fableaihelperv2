/**
 * Redaction helpers used before anything is logged or exported from
 * diagnostics. Deliberately aggressive: false positives are acceptable,
 * leaked credentials are not.
 */

const PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // Authorization headers / bearer tokens
  {
    re: /(authorization\s*[:=]\s*)("?)(bearer\s+)?[\w.~+/-]{8,}("?)/gi,
    replacement: '$1$2$3[REDACTED]$4',
  },
  { re: /\bbearer\s+[\w.~+/-]{8,}/gi, replacement: 'Bearer [REDACTED]' },
  // Known provider key shapes
  { re: /\bgsk_[A-Za-z0-9_-]{10,}\b/g, replacement: '[REDACTED]' },
  { re: /\bsk-or-[A-Za-z0-9_-]{10,}\b/g, replacement: '[REDACTED]' },
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replacement: '[REDACTED]' },
  { re: /\bAIza[A-Za-z0-9_-]{20,}\b/g, replacement: '[REDACTED]' },
  // key/token/secret query params or JSON fields
  {
    re: /((?:api[_-]?key|key|token|secret|password)\s*["']?\s*[:=]\s*["']?)[^"'&\s]{6,}/gi,
    replacement: '$1[REDACTED]',
  },
];

/** Replace credential-shaped substrings (bearer tokens, provider key formats,
 *  key/token/password fields) with [REDACTED]. Apply to any free text before
 *  it is logged or exported. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { re, replacement } of PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

/** Redact string values recursively in a JSON-safe structure. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = /^(authorization|api[-_]?key|key|token|secret|password)$/i.test(k)
        ? '[REDACTED]'
        : redactDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}
