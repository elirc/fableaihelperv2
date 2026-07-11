import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppCapabilities,
  DiagnosticsReport,
  HistoryItem,
  ModelSummary,
  OperationEvent,
  Profile,
  ProviderMeta,
  ProviderProbe,
  PublicSettings,
  SessionEvent,
  SessionOptions,
} from '../shared/domain';

/**
 * Fixed, typed preload API (spec §11.1). No `ipcRenderer` object, generic
 * `send`, channel name, or Electron event object ever reaches the page.
 * Subscriptions return an unsubscribe function.
 */

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).catch((err: unknown) => {
    // Errors arrive as "Error invoking remote method 'x': PublicError: {json}".
    if (err instanceof Error) {
      const match = err.message.match(/\{.*\}$/s);
      if (match) {
        try {
          return Promise.reject(JSON.parse(match[0]));
        } catch {
          /* fall through to generic rejection */
        }
      }
    }
    return Promise.reject({
      code: 'UNKNOWN',
      message: 'The request failed.',
      retryable: true,
    });
  }) as Promise<T>;
}

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener as never);
  return () => ipcRenderer.removeListener(channel, listener as never);
}

const api = {
  getCapabilities: () => invoke<AppCapabilities>('app:getCapabilities'),
  openPreferences: () => invoke<boolean>('app:openPreferences'),
  openExternal: (url: string) => invoke<boolean>('app:openExternal', { url }),

  getPublicSettings: () => invoke<PublicSettings>('settings:getPublic'),
  updatePublicSettings: (patch: Partial<PublicSettings>) =>
    invoke<PublicSettings>('settings:updatePublic', patch),

  setSecret: (providerId: string, value: string) =>
    invoke<{ hasCredential: boolean }>('secrets:set', { providerId, value }),
  removeSecret: (providerId: string) =>
    invoke<{ hasCredential: boolean }>('secrets:remove', { providerId }),

  listProviders: () => invoke<ProviderMeta[]>('providers:list'),
  probeProvider: (providerId: string) => invoke<ProviderProbe>('providers:probe', { providerId }),
  listModels: (providerId: string) => invoke<ModelSummary[]>('models:list', { providerId }),
  downloadModel: (modelId: string) =>
    invoke<{ operationId: string }>('models:download', { modelId }),
  cancelDownload: (operationId: string) =>
    invoke<boolean>('models:cancelDownload', { operationId }),

  armCapture: (sessionId: string) => invoke<{ expiresAt: number }>('capture:arm', { sessionId }),
  submitSession: (sessionId: string, wav: ArrayBuffer, options: SessionOptions, encodeMs: number) =>
    invoke<{ accepted: boolean }>('session:submit', { sessionId, options, encodeMs }, wav),
  regenerate: (sessionId: string, transcript: string, options: SessionOptions) =>
    invoke<{ accepted: boolean }>('session:regenerate', { sessionId, transcript, options }),
  cancelSession: (sessionId: string) =>
    invoke<{ cancelled: boolean }>('session:cancel', { sessionId }),

  listHistory: (limit?: number) => invoke<HistoryItem[]>('history:list', { limit: limit ?? 100 }),
  deleteHistoryItem: (id: string) => invoke<{ deleted: boolean }>('history:delete', { id }),
  clearHistory: () => invoke<{ cleared: boolean }>('history:clear'),
  exportHistory: () => invoke<HistoryItem[]>('history:export'),

  listProfiles: () => invoke<Profile[]>('profiles:list'),
  saveProfile: (profile: {
    id?: string;
    name: string;
    summary: string;
    roleContext: string;
    emphasisNotes: string;
  }) => invoke<Profile>('profiles:save', profile),
  deleteProfile: (id: string) => invoke<{ deleted: boolean }>('profiles:delete', { id }),

  getDiagnostics: () => invoke<DiagnosticsReport>('diagnostics:get'),
  exportDiagnostics: (options: { includeTranscripts?: boolean; includeProfile?: boolean }) =>
    invoke<string>('diagnostics:export', options),

  onSessionEvent: (callback: (event: SessionEvent) => void) =>
    subscribe<SessionEvent>('session:event', callback),
  onOperationEvent: (callback: (event: OperationEvent) => void) =>
    subscribe<OperationEvent>('operation:event', callback),
};

export type CueDeckApi = typeof api;

contextBridge.exposeInMainWorld('cuedeck', api);
