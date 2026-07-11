import { app, shell, session, type BrowserWindow, type WebContents } from 'electron';
import { isAllowedExternalUrl } from './urlPolicy';

export { isAllowedExternalUrl } from './urlPolicy';

/**
 * Window/session hardening (spec §17). Navigation away from the app is
 * denied, window creation is denied, permissions are denied by default,
 * and openExternal only accepts parsed HTTPS URLs from a fixed allowlist.
 */

export function isTrustedAppUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === 'file:') return true;
    if (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    ) {
      // Vite dev server during development only.
      return !app.isPackaged;
    }
    return false;
  } catch {
    return false;
  }
}

export function isTrustedSender(contents: WebContents | undefined | null): boolean {
  if (!contents || contents.isDestroyed()) return false;
  return isTrustedAppUrl(contents.getURL());
}

export async function openExternalChecked(rawUrl: string): Promise<boolean> {
  if (!isAllowedExternalUrl(rawUrl)) return false;
  await shell.openExternal(new URL(rawUrl).toString());
  return true;
}

export function hardenWebContents(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedAppUrl(url)) event.preventDefault();
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
}

export function hardenSession(): void {
  const ses = session.defaultSession;

  // Deny every permission the app does not use. Media (for the armed
  // display-media flow) and sanitized clipboard *writes* (the Copy button)
  // are the only grants, and only for trusted frames.
  const allowed = new Set(['media', 'clipboard-sanitized-write']);
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    const trusted = isTrustedSender(webContents);
    callback(trusted && allowed.has(permission));
  });
  ses.setPermissionCheckHandler((webContents, permission) => {
    return isTrustedSender(webContents ?? null) && allowed.has(permission);
  });

  // CSP header on every response we serve. Dev needs the Vite client
  // (inline bootstrap + websocket); packaged builds get the strict policy.
  const policy = app.isPackaged ? CSP_POLICY : DEV_CSP_POLICY;
  ses.webRequest.onHeadersReceived((details, callback) => {
    if (details.url.startsWith('devtools:') || details.url.startsWith('chrome-extension:')) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    });
  });
}

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

export const CSP_POLICY = [
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
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');
