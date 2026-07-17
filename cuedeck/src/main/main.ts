import { app, BrowserWindow, desktopCapturer, safeStorage, session } from 'electron';
import os from 'node:os';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import type { OperationEvent, SessionEvent } from '../shared/domain';
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
import { createCoachWindow, createPreferencesWindow } from './windows/windows';
import { SttWorkerManager } from './workers/sttWorkerManager';

if (started) {
  app.quit();
}

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

function preloadPath(): string {
  return path.join(__dirname, 'preload.js');
}

function broadcast(
  channel: 'session:event' | 'operation:event',
  payload: SessionEvent | OperationEvent,
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
  registry.registerLlm(new OpenRouterProvider(keyFor('openrouter')));

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
    openPreferencesWindow: () => {
      if (preferencesWindow && !preferencesWindow.isDestroyed()) {
        preferencesWindow.focus();
        return;
      }
      preferencesWindow = createPreferencesWindow(preloadPath(), coachWindow ?? undefined);
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

  const initial = await settings.get();
  coachWindow = createCoachWindow(preloadPath(), initial.alwaysOnTop);
  coachWindow.on('closed', () => {
    coachWindow = null;
  });
}

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
  if (BrowserWindow.getAllWindows().length === 0) void bootstrap();
});

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});
