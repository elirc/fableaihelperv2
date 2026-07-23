import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import type { AppCapabilities, OperationEvent, SessionEvent } from '../../shared/domain';
import {
  captureArmSchema,
  diagnosticsExportSchema,
  historyDeleteSchema,
  historyListQuerySchema,
  modelsDownloadSchema,
  modelsListSchema,
  openExternalSchema,
  profileDeleteSchema,
  profileSaveSchema,
  providersProbeSchema,
  secretsRemoveSchema,
  secretsSetSchema,
  sessionCancelSchema,
  sessionRegenerateSchema,
  sessionSubmitMetaSchema,
  WAV_MAX_BYTES,
  WAV_MIN_BYTES,
} from '../../shared/schemas';
import { TIMEOUTS } from '../../shared/constants';
import { CoachError, toPublicError } from '../../shared/errors';
import type { Diagnostics } from '../diagnostics';
import type { ProviderRegistry } from '../providers/registry';
import type { CaptureGrant } from '../security/captureGrant';
import { isTrustedSender, openExternalChecked } from '../security/windowSecurity';
import type { PublicSettingsStore } from '../settings/publicStore';
import type { SecretVault } from '../settings/secretVault';
import type { SessionCoordinator } from '../sessions/coordinator';
import type { HistoryStore } from '../storage/historyStore';
import type { ProfileStore } from '../storage/profileStore';
import type { SttWorkerManager } from '../workers/sttWorkerManager';

export interface AppServices {
  settings: PublicSettingsStore;
  secrets: SecretVault;
  history: HistoryStore;
  profiles: ProfileStore;
  registry: ProviderRegistry;
  coordinator: SessionCoordinator;
  captureGrant: CaptureGrant;
  diagnostics: Diagnostics;
  sttWorkers: SttWorkerManager;
  capabilities: () => AppCapabilities;
  broadcast: (
    channel: 'session:event' | 'operation:event',
    payload: SessionEvent | OperationEvent,
  ) => void;
  openPreferencesWindow: () => void;
  applyWindowSettings: () => Promise<void>;
}

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown> | unknown;

/**
 * Every privileged method validates the sender frame and its payload
 * before doing anything (spec §17.8-9). Errors cross the boundary as
 * structured PublicError objects, never stack traces.
 */
function secureHandle(channel: string, handler: Handler): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (
      !isTrustedSender(event.sender as WebContents) ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      throw new Error('untrusted sender');
    }
    try {
      return await handler(event, ...args);
    } catch (err) {
      // Zod errors and internal errors all map to a structured public error.
      const publicErr = toPublicError(err);
      const wrapped = new Error(JSON.stringify(publicErr));
      wrapped.name = 'PublicError';
      throw wrapped;
    }
  });
}

const downloadOperations = new Map<string, AbortController>();

export function registerIpc(services: AppServices): void {
  secureHandle('app:getCapabilities', () => services.capabilities());

  secureHandle('app:openPreferences', () => {
    services.openPreferencesWindow();
    return true;
  });

  secureHandle('app:openExternal', async (_event, raw) => {
    const { url } = openExternalSchema.parse(raw);
    return openExternalChecked(url);
  });

  // ---- settings -----------------------------------------------------------

  secureHandle('settings:getPublic', () => services.settings.get());

  secureHandle('settings:updatePublic', async (_event, patch) => {
    const updated = await services.settings.patch(patch);
    await services.applyWindowSettings();
    return updated;
  });

  // ---- secrets (write-only from the renderer) ------------------------------

  secureHandle('secrets:set', async (_event, raw) => {
    const { providerId, value } = secretsSetSchema.parse(raw);
    await services.secrets.set(providerId, value);
    await services.settings.setCredentialFlag(providerId, true);
    return { hasCredential: true };
  });

  secureHandle('secrets:remove', async (_event, raw) => {
    const { providerId } = secretsRemoveSchema.parse(raw);
    await services.secrets.remove(providerId);
    await services.settings.setCredentialFlag(providerId, false);
    return { hasCredential: false };
  });

  // ---- providers and models -------------------------------------------------

  secureHandle('providers:list', () => services.registry.list());

  secureHandle('providers:probe', async (_event, raw) => {
    const { providerId } = providersProbeSchema.parse(raw);
    const provider = services.registry.getAny(providerId);
    return provider.probe(AbortSignal.timeout(TIMEOUTS.probe));
  });

  secureHandle('models:list', async (_event, raw) => {
    const { providerId } = modelsListSchema.parse(raw);
    const provider = services.registry.getAny(providerId);
    return provider.listModels(AbortSignal.timeout(TIMEOUTS.probe));
  });

  secureHandle('models:download', (_event, raw) => {
    const { modelId } = modelsDownloadSchema.parse(raw);
    const operationId = randomUUID();
    const controller = new AbortController();
    downloadOperations.set(operationId, controller);
    void services.sttWorkers
      .ensureModel(
        modelId,
        (p) =>
          services.broadcast('operation:event', {
            type: 'progress',
            operationId,
            stage: p.stage,
            value: p.value,
            detail: p.file,
          }),
        controller.signal,
      )
      .then(() => {
        services.broadcast('operation:event', { type: 'complete', operationId });
      })
      .catch((err: unknown) => {
        services.broadcast('operation:event', {
          type: 'error',
          operationId,
          error: toPublicError(err),
        });
      })
      .finally(() => downloadOperations.delete(operationId));
    return { operationId };
  });

  secureHandle('models:cancelDownload', (_event, raw) => {
    const { operationId } = (raw ?? {}) as { operationId?: string };
    if (typeof operationId !== 'string') throw new CoachError('UNKNOWN', 'missing operationId');
    downloadOperations.get(operationId)?.abort();
    return true;
  });

  // ---- capture ---------------------------------------------------------------

  secureHandle('capture:arm', (_event, raw) => {
    const { sessionId } = captureArmSchema.parse(raw);
    // Warm the LLM while the clip is still being recorded so the model's
    // cold start never lands on the time-to-first-token path.
    void services.coordinator.prewarm();
    return services.captureGrant.arm(sessionId);
  });

  // ---- session ---------------------------------------------------------------

  secureHandle('session:submit', (_event, rawMeta, wav) => {
    const meta = sessionSubmitMetaSchema.parse(rawMeta);
    if (!(wav instanceof ArrayBuffer) && !ArrayBuffer.isView(wav)) {
      throw new CoachError('UNKNOWN', 'audio payload must be binary');
    }
    const bytes =
      wav instanceof ArrayBuffer
        ? new Uint8Array(wav)
        : new Uint8Array(wav.buffer, wav.byteOffset, wav.byteLength);
    if (bytes.byteLength < WAV_MIN_BYTES) throw new CoachError('AUDIO_TOO_SHORT');
    if (bytes.byteLength > WAV_MAX_BYTES) throw new CoachError('AUDIO_TOO_LONG');
    void services.coordinator.submit(meta.sessionId, bytes, meta.options, meta.encodeMs);
    return { accepted: true };
  });

  secureHandle('session:regenerate', (_event, raw) => {
    const { sessionId, transcript, options } = sessionRegenerateSchema.parse(raw);
    void services.coordinator.regenerate(sessionId, transcript, options);
    return { accepted: true };
  });

  secureHandle('session:cancel', (_event, raw) => {
    const { sessionId } = sessionCancelSchema.parse(raw);
    services.coordinator.cancel(sessionId);
    services.captureGrant.disarm();
    return { cancelled: true };
  });

  // ---- history ----------------------------------------------------------------

  secureHandle('history:list', async (_event, raw) => {
    const { limit } = historyListQuerySchema.parse(raw ?? {});
    const settings = await services.settings.get();
    if (!settings.historyEnabled) return [];
    return services.history.list(limit, settings.historyRetentionDays);
  });

  secureHandle('history:delete', async (_event, raw) => {
    const { id } = historyDeleteSchema.parse(raw);
    await services.history.delete(id);
    return { deleted: true };
  });

  secureHandle('history:clear', async () => {
    await services.history.clear();
    return { cleared: true };
  });

  secureHandle('history:export', async () => services.history.exportAll());

  // ---- profiles ------------------------------------------------------------------

  secureHandle('profiles:list', () => services.profiles.list());

  secureHandle('profiles:save', async (_event, raw) => {
    const input = profileSaveSchema.parse(raw);
    return services.profiles.save(input);
  });

  secureHandle('profiles:delete', async (_event, raw) => {
    const { id } = profileDeleteSchema.parse(raw);
    await services.profiles.delete(id);
    return { deleted: true };
  });

  // ---- diagnostics ----------------------------------------------------------------

  secureHandle('diagnostics:get', () => services.diagnostics.report());

  secureHandle('diagnostics:export', async (_event, raw) => {
    const options = diagnosticsExportSchema.parse(raw ?? {});
    let transcripts: string | undefined;
    let profile: string | undefined;
    if (options.includeTranscripts) {
      const settings = await services.settings.get();
      if (settings.historyEnabled) {
        const items = await services.history.list(20, settings.historyRetentionDays);
        transcripts = items.map((i) => `${i.createdAt}: ${i.transcript}`).join('\n');
      }
    }
    if (options.includeProfile) {
      const settings = await services.settings.get();
      const active = settings.activeProfileId
        ? await services.profiles.get(settings.activeProfileId)
        : null;
      profile = active ? `${active.name}\n${active.summary}\n${active.roleContext}` : undefined;
    }
    return services.diagnostics.exportText({ transcripts, profile });
  });
}
