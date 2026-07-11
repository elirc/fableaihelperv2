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
  return parsed.success ? parsed.data : { ...DEFAULT_SETTINGS };
}
