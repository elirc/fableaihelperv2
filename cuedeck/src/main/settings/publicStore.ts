import path from 'node:path';
import { CLOUD_MODELS } from '../../shared/catalog';
import { DEFAULT_SETTINGS } from '../../shared/constants';
import type { PublicSettings } from '../../shared/domain';
import { publicSettingsPatchSchema } from '../../shared/schemas';
import { readJsonFile, writeJsonFile } from '../storage/jsonFile';
import { migrateSettings } from './migrations';

/**
 * Public (non-secret) settings. Credential *values* never live here — only
 * `configured` flags maintained by the secret vault.
 */
export class PublicSettingsStore {
  private readonly filePath: string;
  private cache: PublicSettings | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(userDataDir: string) {
    this.filePath = path.join(userDataDir, 'settings.json');
  }

  async load(): Promise<PublicSettings> {
    if (this.cache) return this.cache;
    const raw = await readJsonFile(this.filePath).catch(() => null);
    this.cache = migrateSettings(raw);
    return this.cache;
  }

  async get(): Promise<PublicSettings> {
    return this.load();
  }

  async patch(rawPatch: unknown): Promise<PublicSettings> {
    const patch = publicSettingsPatchSchema.parse(rawPatch);
    const current = await this.load();
    const next: PublicSettings = { ...current, ...patch };
    // A provider-only change must not carry a model from the previous
    // provider. Preferences and the local-only shortcut both use this path.
    if (
      patch.sttProviderId !== undefined &&
      patch.sttProviderId !== current.sttProviderId &&
      patch.sttModelId === undefined
    ) {
      const defaults: Record<string, string> = {
        'local-whisper': DEFAULT_SETTINGS.sttModelId,
        'groq-whisper': CLOUD_MODELS.groqSttModel,
        'gemini-audio': CLOUD_MODELS.geminiModel,
      };
      next.sttModelId = defaults[patch.sttProviderId] ?? current.sttModelId;
    }
    if (
      patch.llmProviderId !== undefined &&
      patch.llmProviderId !== current.llmProviderId &&
      patch.llmModelId === undefined
    ) {
      next.llmModelId = '';
    }
    return this.replace(next);
  }

  /** Internal-only writes (e.g. credential flags); bypasses the renderer patch schema. */
  async replace(next: PublicSettings): Promise<PublicSettings> {
    this.cache = next;
    // Chain writes so they reach disk in order, but never let a failed write
    // poison the chain — that would reject every future write unattempted.
    const write = this.writeChain
      .catch(() => undefined)
      .then(() => writeJsonFile(this.filePath, next));
    this.writeChain = write.catch(() => undefined);
    await write;
    return next;
  }

  async setCredentialFlag(providerId: string, configured: boolean): Promise<PublicSettings> {
    const current = await this.load();
    const credentials = { ...current.credentials };
    if (configured) credentials[providerId] = { configured: true };
    else delete credentials[providerId];
    return this.replace({ ...current, credentials });
  }
}
