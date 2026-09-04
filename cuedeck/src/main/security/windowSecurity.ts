import { app, shell, session, type BrowserWindow, type WebContents } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CSP_POLICY, DEV_CSP_POLICY } from '../../shared/csp';
import { isAllowedExternalUrl } from './urlPolicy';

export { CSP_POLICY, DEV_CSP_POLICY } from '../../shared/csp';

export { isAllowedExternalUrl } from './urlPolicy';

/**
 * Window/session hardening (spec §17). Navigation away from the app is
 * denied, window creation is denied, permissions are denied by default,
 * and openExternal only accepts parsed HTTPS URLs from a fixed allowlist.
 */

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string | undefined;

/** Where the renderer is served from; the only origin/file a trusted frame may have. */
export interface RendererEntry {
  /** Vite dev server origin (development only). */
  devUrl?: string;
  /** Absolute path of the built renderer's index.html (packaged builds). */
  file?: string;
  packaged: boolean;
}

/** Mirrors the entry `windows.ts` loads; both live in the same main bundle. */
function appRendererEntry(): RendererEntry {
  const devUrl =
    typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'undefined'
      ? MAIN_WINDOW_VITE_DEV_SERVER_URL
      : undefined;
  if (devUrl) return { devUrl, packaged: app.isPackaged };
  const name = typeof MAIN_WINDOW_VITE_NAME !== 'undefined' ? MAIN_WINDOW_VITE_NAME : 'main_window';
  return { file: path.join(__dirname, `../renderer/${name}/index.html`), packaged: app.isPackaged };
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const decoded = decodeURIComponent(p);
    return process.platform === 'win32' ? decoded.toLowerCase() : decoded;
  };
  return norm(a) === norm(b);
}

/**
 * True only for the app's own renderer: the exact built index.html (any
 * hash route) in a packaged build, or the exact Vite dev-server origin in
 * development. Every other file:// or http:// document is untrusted, so a
 * stray local page can neither navigate the window nor receive a
 * permission or capture grant.
 */
export function isTrustedRendererUrl(rawUrl: string, entry: RendererEntry): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (entry.devUrl) {
    if (entry.packaged) return false;
    let dev: URL;
    try {
      dev = new URL(entry.devUrl);
    } catch {
      return false;
    }
    return url.protocol === 'http:' && url.origin === dev.origin;
  }
  if (!entry.file || url.protocol !== 'file:') return false;
  try {
    return samePath(url.pathname, pathToFileURL(entry.file).pathname);
  } catch {
    return false; // malformed percent-encoding
  }
}

export function isTrustedAppUrl(rawUrl: string): boolean {
  return isTrustedRendererUrl(rawUrl, appRendererEntry());
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
  // file:// loads never see this header — the built index.html carries the
  // strict policy as a meta tag instead (vite.renderer.config.ts).
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
