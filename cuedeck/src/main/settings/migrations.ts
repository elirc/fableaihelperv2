import { CLOUD_MODELS } from '../../shared/catalog';
import { DEFAULT_SETTINGS } from '../../shared/constants';
import type { PublicSettings } from '../../shared/domain';
import { publicSettingsSchema } from '../../shared/schemas';

/**
 * Settings migrations. Each entry upgrades from its index version to the
 * next; unknown/corrupt data falls back to defaults rather than crashing.
 */
type Migration = (raw: Record<string, unknown>) => Record<string, unknown>;

export const CURRENT_SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, Migration> = {
  // 0 -> 1: pre-release settings had no schemaVersion; adopt defaults for
  // any missing field.
  0: (raw) => ({ ...raw, schemaVersion: 1 }),
};

/**
 * Cloud model IDs a provider has withdrawn, mapped to the current catalog
 * default. Applied on every load (not versioned) so a settings file that
 * still names a retired model keeps working instead of failing every request
 * with "model not found".
 */
export const RETIRED_CLOUD_MODELS: Record<string, Record<string, string>> = {
  groq: {
    'llama-3.3-70b-versatile': CLOUD_MODELS.groqLlmModel,
    'llama-3.1-8b-instant': CLOUD_MODELS.groqLlmFastModel,
  },
  cerebras: {
    'llama-3.3-70b': CLOUD_MODELS.cerebrasModel,
    'llama3.1-8b': CLOUD_MODELS.cerebrasFastModel,
  },
};

function remapRetiredModels(settings: PublicSettings): PublicSettings {
  const remap = (providerId: string, modelId: string): string =>
    RETIRED_CLOUD_MODELS[providerId]?.[modelId] ?? modelId;
  return {
    ...settings,
    llmModelId: remap(settings.llmProviderId, settings.llmModelId),
    llmBackupModelId: remap(settings.llmBackupProviderId, settings.llmBackupModelId),
  };
}

export function migrateSettings(raw: unknown): PublicSettings {
  if (raw === null || typeof raw !== 'object') return { ...DEFAULT_SETTINGS };
  let data = { ...(raw as Record<string, unknown>) };
  let version = typeof data.schemaVersion === 'number' ? data.schemaVersion : 0;
  if (version > CURRENT_SCHEMA_VERSION) {
    // Data written by a newer app version; start clean rather than guess.
    return { ...DEFAULT_SETTINGS };
  }
  while (version < CURRENT_SCHEMA_VERSION) {
    const migrate = MIGRATIONS[version];
    if (!migrate) return { ...DEFAULT_SETTINGS };
    data = migrate(data);
    version = typeof data.schemaVersion === 'number' ? data.schemaVersion : version + 1;
  }
  const parsed = publicSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...data });
  return parsed.success ? remapRetiredModels(parsed.data) : { ...DEFAULT_SETTINGS };
}
