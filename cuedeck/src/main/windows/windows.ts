import { BrowserWindow } from 'electron';
import path from 'node:path';
import type { PreferencesSection } from '../../shared/domain';
import { hardenWebContents } from '../security/windowSecurity';

/**
 * Window factory. Both windows use the same sandboxed renderer bundle;
 * the preferences window navigates straight to the #/preferences route.
 * There is deliberately no `setContentProtection` call anywhere: the app
 * never hides itself from capture (spec §0.8, §17.18).
 */

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string | undefined;

function rendererEntry(): { devUrl?: string; file?: string } {
  const devUrl =
    typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'undefined'
      ? MAIN_WINDOW_VITE_DEV_SERVER_URL
      : undefined;
  if (devUrl) return { devUrl };
  const name = typeof MAIN_WINDOW_VITE_NAME !== 'undefined' ? MAIN_WINDOW_VITE_NAME : 'main_window';
  return { file: path.join(__dirname, `../renderer/${name}/index.html`) };
}

const SECURE_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webviewTag: false,
  spellcheck: false,
} as const;

export function createCoachWindow(preloadPath: string, alwaysOnTop: boolean): BrowserWindow {
  const win = new BrowserWindow({
    width: 620,
    height: 640,
    minWidth: 440,
    minHeight: 360,
    alwaysOnTop,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b1020',
    title: 'CueDeck',
    webPreferences: { ...SECURE_PREFERENCES, preload: preloadPath },
  });
  hardenWebContents(win);
  const entry = rendererEntry();
  if (entry.devUrl) void win.loadURL(`${entry.devUrl}#/`);
  else void win.loadFile(entry.file as string);
  win.once('ready-to-show', () => win.show());
  return win;
}

function preferencesHash(section?: PreferencesSection): string {
  return section ? `/preferences/${section}` : '/preferences';
}

/**
 * Point the preferences window at a section. Only the fragment changes, so
 * this is an in-page navigation the renderer's hashchange listener picks up.
 */
export function showPreferencesSection(win: BrowserWindow, section?: PreferencesSection): void {
  const entry = rendererEntry();
  const hash = preferencesHash(section);
  // Loading a URL identical to the current one is a reload, which would
  // remount the page and drop a half-typed key or a download in progress.
  const current = win.webContents.getURL();
  if (current && current.endsWith(`#${hash}`)) return;
  if (entry.devUrl) void win.loadURL(`${entry.devUrl}#${hash}`);
  else void win.loadFile(entry.file as string, { hash });
}

export function createPreferencesWindow(
  preloadPath: string,
  parent?: BrowserWindow,
  section?: PreferencesSection,
): BrowserWindow {
  const win = new BrowserWindow({
    width: 720,
    height: 680,
    minWidth: 560,
    minHeight: 480,
    parent,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b1020',
    title: 'CueDeck Preferences',
    webPreferences: { ...SECURE_PREFERENCES, preload: preloadPath },
  });
  hardenWebContents(win);
  showPreferencesSection(win, section);
  win.once('ready-to-show', () => win.show());
  return win;
}
