import { app, BrowserWindow, desktopCapturer, safeStorage, session } from 'electron';
import os from 'node:os';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import type { OperationEvent, PublicSettings, SessionEvent } from '../shared/domain';
import { Diagnostics } from './diagnostics';
import { registerIpc, type AppServices } from './ipc/register';
import { ProviderRegistry } from './providers/registry';
import { CerebrasLlmProvider } from './providers/llm/cerebras';
import { GeminiLlmProvider } from './providers/llm/gemini';
import { GroqLlmProvider } from './providers/llm/groq';
import { OllamaProvider } from './providers/llm/ollama';
import { OpenRouterProvider } from './providers/llm/openRouter';
import { GeminiAudioProvider } from './providers/stt/geminiAudio';
import { GroqWhisperProvider } from './providers/stt/groqWhisper';
import { LocalWhisperProvider } from './providers/stt/localWhisper';
import { CaptureGrant } from './security/captureGrant';
import { hardenSession, isTrustedAppUrl } from './security/windowSecurity';
import { PublicSettingsStore } from './settings/publicStore';
import { SecretVault } from './settings/secretVault';
import { SessionCoordinator } from './sessions/coordinator';
import { HistoryStore } from './storage/historyStore';
import { ProfileStore } from './storage/profileStore';
import {
  createCoachWindow,
  createPreferencesWindow,
  showPreferencesSection,
} from './windows/windows';
import { SttWorkerManager } from './workers/sttWorkerManager';

if (started) {
  app.quit();
}

// Squirrel.Windows shortcuts carry this AppUserModelID; setting the same one
// keeps taskbar pinning and notification grouping attached to the app.
app.setAppUserModelId('com.squirrel.cuedeck.cuedeck');

// E2E-test hook: isolate user data (settings, secrets, history) per run.
// Harmless in production, where the variable is unset.
if (process.env.CUEDECK_USER_DATA) {
  app.setPath('userData', process.env.CUEDECK_USER_DATA);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let coachWindow: BrowserWindow | null = null;
let preferencesWindow: BrowserWindow | null = null;
/** Set once `bootstrap` has wired services; `activate` only recreates the window. */
let settingsStore: PublicSettingsStore | null = null;

async function openCoachWindow(settings: PublicSettingsStore): Promise<BrowserWindow> {
  const current = await settings.get();
  const win = createCoachWindow(preloadPath(), current.alwaysOnTop);
  win.on('closed', () => {
    if (coachWindow === win) coachWindow = null;
  });
  coachWindow = win;
  return win;
}

function preloadPath(): string {
  return path.join(__dirname, 'preload.js');
}

function broadcast(
  channel: 'session:event' | 'operation:event' | 'settings:changed',
  payload: SessionEvent | OperationEvent | PublicSettings,
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

async function bootstrap(): Promise<void> {
  const userData = app.getPath('userData');
  const modelsDir = path.join(userData, 'models');

  const settings = new PublicSettingsStore(userData);
  const secrets = new SecretVault(userData, safeStorage);
  const history = new HistoryStore(userData);
  const profiles = new ProfileStore(userData);
  const captureGrant = new CaptureGrant();
  const sttWorkers = new SttWorkerManager(path.join(__dirname, 'sttWorker.js'), modelsDir);

  const registry = new ProviderRegistry();
  const keyFor = (providerId: string) => () => secrets.getForAdapter(providerId);
  registry.registerStt(
    new LocalWhisperProvider(sttWorkers, async () => (await settings.get()).sttModelId),
  );
  registry.registerStt(new GroqWhisperProvider(keyFor('groq')));
  registry.registerStt(new GeminiAudioProvider(keyFor('gemini')));
  registry.registerLlm(new OllamaProvider(async () => (await settings.get()).ollamaBaseUrl));
  registry.registerLlm(new GroqLlmProvider(keyFor('groq')));
  registry.registerLlm(new CerebrasLlmProvider(keyFor('cerebras')));
  registry.registerLlm(new GeminiLlmProvider(keyFor('gemini')));
  registry.registerLlm(
    new OpenRouterProvider(
      keyFor('openrouter'),
      undefined,
      async () => (await settings.get()).allowPaidModels,
    ),
  );

  const diagnostics = new Diagnostics(
    app.getVersion(),
    async () => {
      const s = await settings.get();
      return { stt: s.sttProviderId, llm: s.llmProviderId };
    },
    () => {
      const status = sttWorkers.getStatus();
      return status.modelId ? `${status.state} (${status.modelId})` : status.state;
    },
  );

  const coordinator = new SessionCoordinator({
    registry,
    getSettings: () => settings.get(),
    // Same write-then-broadcast path as the settings:updatePublic handler, so
    // a model the coordinator resolved reaches the coach window's status rail.
    updateSettings: async (patch) => {
      const updated = await settings.patch(patch);
      broadcast('settings:changed', updated);
    },
    getProfile: (id) => profiles.get(id),
    saveHistory: (item, retentionDays) => history.add(item, retentionDays),
    emit: (event) => broadcast('session:event', event),
    recordError: (code, message) => diagnostics.recordError(code, message),
  });

  const services: AppServices = {
    settings,
    secrets,
    history,
    profiles,
    registry,
    coordinator,
    captureGrant,
    diagnostics,
    sttWorkers,
    capabilities: () => ({
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      platform: process.platform,
      osVersion: os.release(),
      safeStorageAvailable: safeStorage.isEncryptionAvailable(),
      totalMemoryMb: Math.round(os.totalmem() / (1024 * 1024)),
    }),
    broadcast,
    openPreferencesWindow: (section) => {
      if (preferencesWindow && !preferencesWindow.isDestroyed()) {
        if (section) showPreferencesSection(preferencesWindow, section);
        preferencesWindow.focus();
        return;
      }
      preferencesWindow = createPreferencesWindow(preloadPath(), coachWindow ?? undefined, section);
      preferencesWindow.on('closed', () => {
        preferencesWindow = null;
      });
    },
    applyWindowSettings: async () => {
      const s = await settings.get();
      if (coachWindow && !coachWindow.isDestroyed()) {
        coachWindow.setAlwaysOnTop(s.alwaysOnTop);
      }
    },
  };

  hardenSession();

  // Armed, one-use display-media grant (spec §5.2-E). Every request that
  // does not follow an explicit `capture:arm` from a trusted frame within
  // the TTL is denied.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const frameUrl = request.frame?.url ?? '';
    if (!isTrustedAppUrl(frameUrl) || !captureGrant.consume()) {
      callback({});
      return;
    }
    desktopCapturer
      .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => {
        if (sources.length === 0) {
          callback({});
          return;
        }
        // The smallest disposable video source Electron requires on
        // Windows, plus system loopback audio. The renderer stops the
        // video track immediately; only audio is processed.
        callback({ video: sources[0], audio: 'loopback' });
      })
      .catch(() => callback({}));
  });

  registerIpc(services);
  settingsStore = settings;

  await openCoachWindow(settings);

  // First-turn warmup: people open CueDeck right before they need it, so
  // load the local models now rather than inside the first Listen. Delayed
  // so the window paints first; a no-op until onboarding is complete.
  const initial = await settings.get();
  if (initial.onboardingComplete) {
    setTimeout(() => void coordinator.prewarm(), STARTUP_PREWARM_DELAY_MS).unref?.();
  }
}

const STARTUP_PREWARM_DELAY_MS = 1_500;

app.on('second-instance', () => {
  if (coachWindow && !coachWindow.isDestroyed()) {
    if (coachWindow.isMinimized()) coachWindow.restore();
    coachWindow.focus();
  }
});

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  // Services and IPC handlers are registered once; re-running bootstrap
  // here would throw on the duplicate ipcMain.handle registrations.
  if (BrowserWindow.getAllWindows().length > 0) return;
  if (settingsStore) void openCoachWindow(settingsStore);
  else void bootstrap();
});

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});
