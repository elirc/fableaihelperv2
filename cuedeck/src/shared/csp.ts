/**
 * Renderer Content-Security-Policy, in one place for both delivery paths:
 * the main process injects it as a response header (the only mechanism that
 * reaches the Vite dev server), and the renderer build stamps it into
 * index.html as a meta tag because Chromium ignores injected headers for
 * file:// loads — which is how the packaged app and the E2E build load the UI.
 */

export const DEV_CSP_POLICY = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

const STRICT_DIRECTIVES = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
];

export const CSP_POLICY = [...STRICT_DIRECTIVES, "frame-ancestors 'none'"].join('; ');

/** `frame-ancestors` is header-only (ignored in a meta tag with a console
 *  warning), so the meta variant omits it; nothing can frame a file:// page
 *  inside the app anyway (window.open and webviews are denied). */
export const CSP_META_POLICY = STRICT_DIRECTIVES.join('; ');
