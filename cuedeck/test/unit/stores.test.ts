import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateSettings, RETIRED_CLOUD_MODELS } from '../../src/main/settings/migrations';
import { CLOUD_MODELS } from '../../src/shared/catalog';
import { PublicSettingsStore } from '../../src/main/settings/publicStore';
import { SecretVault, type SafeStorageLike } from '../../src/main/settings/secretVault';
import { applyRetention, HistoryStore } from '../../src/main/storage/historyStore';
import { ProfileStore } from '../../src/main/storage/profileStore';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';
import type { HistoryItem } from '../../src/shared/domain';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cuedeck-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
  decryptString: (buf) => buf.toString('utf8').replace(/^enc:/, ''),
};

describe('migrateSettings', () => {
  it('adds an empty system prompt to older settings without replacing saved choices', () => {
    const migrated = migrateSettings({
      schemaVersion: 1,
      answerMode: 'technical',
      targetSeconds: 90,
      llmProviderId: 'groq',
      llmModelId: CLOUD_MODELS.groqLlmModel,
      activeProfileId: 'backend',
      credentials: { groq: { configured: true } },
    });
    expect(migrated.systemPrompt).toBe('');
    expect(migrated.answerMode).toBe('technical');
    expect(migrated.targetSeconds).toBe(90);
    expect(migrated.llmProviderId).toBe('groq');
    expect(migrated.activeProfileId).toBe('backend');
    expect(migrated.credentials.groq.configured).toBe(true);
  });

  it('preserves a saved custom prompt during settings migration', () => {
    expect(
      migrateSettings({ ...DEFAULT_SETTINGS, systemPrompt: 'Explain using Python.' }).systemPrompt,
    ).toBe('Explain using Python.');
  });

  it('returns defaults for corrupt input', () => {
    expect(migrateSettings('garbage')).toEqual(DEFAULT_SETTINGS);
    expect(migrateSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(migrateSettings({ schemaVersion: 999 })).toEqual(DEFAULT_SETTINGS);
  });

  it('upgrades version 0 data preserving known fields', () => {
    const migrated = migrateSettings({ alwaysOnTop: true });
    expect(migrated.schemaVersion).toBe(1);
    expect(migrated.alwaysOnTop).toBe(true);
    expect(migrated.historyEnabled).toBe(false);
  });

  it('drops invalid field values back to defaults', () => {
    const migrated = migrateSettings({ schemaVersion: 1, fontScale: 99 });
    expect(migrated.fontScale).toBe(1);
  });

  it('remaps retired Groq/Cerebras model ids to the current catalog defaults', () => {
    const migrated = migrateSettings({
      schemaVersion: 1,
      llmProviderId: 'groq',
      llmModelId: 'llama-3.3-70b-versatile',
      llmBackupProviderId: 'cerebras',
      llmBackupModelId: 'llama3.1-8b',
    });
    expect(migrated.llmModelId).toBe(CLOUD_MODELS.groqLlmModel);
    expect(migrated.llmBackupModelId).toBe(CLOUD_MODELS.cerebrasFastModel);
  });

  it('leaves current model ids and other providers alone', () => {
    const migrated = migrateSettings({
      schemaVersion: 1,
      llmProviderId: 'ollama',
      llmModelId: 'llama-3.3-70b-versatile',
      llmBackupProviderId: 'groq',
      llmBackupModelId: CLOUD_MODELS.groqLlmModel,
    });
    expect(migrated.llmModelId).toBe('llama-3.3-70b-versatile');
    expect(migrated.llmBackupModelId).toBe(CLOUD_MODELS.groqLlmModel);
    for (const map of Object.values(RETIRED_CLOUD_MODELS)) {
      for (const target of Object.values(map)) expect(map).not.toHaveProperty(target);
    }
  });

  it('fills the pause-length field added after the file was written', () => {
    const migrated = migrateSettings({ schemaVersion: 1, onboardingComplete: true });
    expect(migrated.trailingSilenceMs).toBe(DEFAULT_SETTINGS.trailingSilenceMs);
    expect(migrated.onboardingComplete).toBe(true);
  });

  it('fills fields added after the file was written (autoStopOnSilence)', () => {
    // A settings.json from a build that predates the field must load with
    // the default instead of being discarded wholesale.
    const migrated = migrateSettings({ schemaVersion: 1, alwaysOnTop: true });
    expect(migrated.autoStopOnSilence).toBe(true);
    expect(migrated.alwaysOnTop).toBe(true);
  });

  it('preserves a user-disabled auto-stop toggle across load', () => {
    const migrated = migrateSettings({ schemaVersion: 1, autoStopOnSilence: false });
    expect(migrated.autoStopOnSilence).toBe(false);
  });
});

describe('PublicSettingsStore', () => {
  it('chooses a compatible speech model when changing providers after setup', async () => {
    const store = new PublicSettingsStore(dir);
    await store.patch({ onboardingComplete: true });
    expect((await store.patch({ sttProviderId: 'groq-whisper' })).sttModelId).toBe(
      CLOUD_MODELS.groqSttModel,
    );
    expect((await store.patch({ sttProviderId: 'gemini-audio' })).sttModelId).toBe(
      CLOUD_MODELS.geminiModel,
    );
    expect((await store.patch({ sttProviderId: 'local-whisper' })).sttModelId).toBe(
      DEFAULT_SETTINGS.sttModelId,
    );
    expect((await new PublicSettingsStore(dir).get()).sttModelId).toBe(DEFAULT_SETTINGS.sttModelId);
  });

  it('resets both incompatible models when switching everything back to local-only', async () => {
    const store = new PublicSettingsStore(dir);
    await store.patch({
      sttProviderId: 'groq-whisper',
      sttModelId: CLOUD_MODELS.groqSttModel,
      llmProviderId: 'groq',
      llmModelId: CLOUD_MODELS.groqLlmModel,
    });
    const settings = await store.patch({ sttProviderId: 'local-whisper', llmProviderId: 'ollama' });
    expect(settings.sttModelId).toBe(DEFAULT_SETTINGS.sttModelId);
    expect(settings.llmModelId).toBe('');
    const restored = await new PublicSettingsStore(dir).get();
    expect(restored.sttModelId).toBe(DEFAULT_SETTINGS.sttModelId);
    expect(restored.llmModelId).toBe('');
  });

  it('preserves explicit model choices and models for an unchanged provider', async () => {
    const store = new PublicSettingsStore(dir);
    await store.patch({
      sttProviderId: 'groq-whisper',
      sttModelId: 'whisper-large-v3',
      llmProviderId: 'groq',
      llmModelId: CLOUD_MODELS.groqLlmFastModel,
    });
    const settings = await store.patch({ sttProviderId: 'groq-whisper', llmProviderId: 'groq' });
    expect(settings.sttModelId).toBe('whisper-large-v3');
    expect(settings.llmModelId).toBe(CLOUD_MODELS.groqLlmFastModel);
    expect((await store.patch({ llmProviderId: 'gemini' })).llmModelId).toBe('');
  });

  it('persists custom instructions across reloads and unrelated patches, and allows clearing them', async () => {
    const store = new PublicSettingsStore(dir);
    await store.patch({ systemPrompt: 'Use examples relevant to backend engineering.' });
    await store.patch({ answerMode: 'technical' });
    const reread = new PublicSettingsStore(dir);
    expect((await reread.get()).systemPrompt).toBe('Use examples relevant to backend engineering.');
    expect((await reread.get()).answerMode).toBe('technical');
    await expect(reread.patch({ systemPrompt: 'x'.repeat(8_001) })).rejects.toThrow();
    expect((await reread.get()).systemPrompt).toBe('Use examples relevant to backend engineering.');
    await reread.patch({ systemPrompt: '' });
    expect((await new PublicSettingsStore(dir).get()).systemPrompt).toBe('');
  });

  it('persists patches and enforces the patch schema', async () => {
    const store = new PublicSettingsStore(dir);
    await store.patch({ alwaysOnTop: true });
    const reread = new PublicSettingsStore(dir);
    expect((await reread.get()).alwaysOnTop).toBe(true);
    await expect(store.patch({ credentials: {} })).rejects.toThrow();
  });

  it('tracks credential flags without values', async () => {
    const store = new PublicSettingsStore(dir);
    await store.setCredentialFlag('groq', true);
    expect((await store.get()).credentials.groq).toEqual({ configured: true });
    await store.setCredentialFlag('groq', false);
    expect((await store.get()).credentials.groq).toBeUndefined();
  });
});

describe('SecretVault', () => {
  it('stores only ciphertext on disk and returns values to adapters only', async () => {
    const vault = new SecretVault(dir, fakeSafeStorage);
    await vault.set('groq', 'gsk_super_secret_value');
    const raw = await readFile(path.join(dir, 'secrets.json'), 'utf8');
    expect(raw).not.toContain('gsk_super_secret_value');
    expect(await vault.has('groq')).toBe(true);
    expect(await vault.getForAdapter('groq')).toBe('gsk_super_secret_value');
    await vault.remove('groq');
    expect(await vault.has('groq')).toBe(false);
    expect(await vault.getForAdapter('groq')).toBeNull();
  });

  it('treats a corrupt vault file as empty so a fresh key can still be saved', async () => {
    await writeFile(path.join(dir, 'secrets.json'), '{"version":1,"entries":{"groq":', 'utf8');
    const vault = new SecretVault(dir, fakeSafeStorage);
    expect(await vault.has('groq')).toBe(false);
    expect(await vault.getForAdapter('groq')).toBeNull();
    await vault.set('groq', 'gsk_replacement');
    expect(await vault.getForAdapter('groq')).toBe('gsk_replacement');
    expect(JSON.parse(await readFile(path.join(dir, 'secrets.json'), 'utf8')).version).toBe(1);
  });

  it('refuses to store when OS encryption is unavailable', async () => {
    const vault = new SecretVault(dir, { ...fakeSafeStorage, isEncryptionAvailable: () => false });
    await expect(vault.set('groq', 'value')).rejects.toThrow(/STORAGE_FAILED/);
  });

  it('settings file never receives the secret value', async () => {
    const settings = new PublicSettingsStore(dir);
    const vault = new SecretVault(dir, fakeSafeStorage);
    await vault.set('gemini', 'AIzaSecretValue123');
    await settings.setCredentialFlag('gemini', true);
    const settingsRaw = await readFile(path.join(dir, 'settings.json'), 'utf8');
    expect(settingsRaw).not.toContain('AIzaSecretValue123');
    expect(JSON.stringify(await settings.get())).not.toContain('AIzaSecretValue123');
  });
});

describe('HistoryStore', () => {
  const item = {
    transcript: 't',
    answer: 'a',
    sttProviderId: 'local-whisper',
    sttModelId: 'm',
    llmProviderId: 'ollama',
    llmModelId: 'q',
    answerMode: 'natural',
    timings: { encodeMs: 1, transcribeMs: 2, totalMs: 3 },
  };

  it('adds, lists, deletes, clears', async () => {
    const store = new HistoryStore(dir);
    await store.add(item, 7);
    await store.add({ ...item, transcript: 't2' }, 7);
    const items = await store.list(10, 7);
    expect(items).toHaveLength(2);
    expect(items[0].transcript).toBe('t2'); // newest first
    await store.delete(items[0].id);
    expect(await store.list(10, 7)).toHaveLength(1);
    await store.clear();
    expect(await store.list(10, 7)).toHaveLength(0);
  });
});

describe('applyRetention', () => {
  const at = (daysAgo: number): HistoryItem => ({
    id: String(daysAgo),
    createdAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    transcript: '',
    answer: '',
    sttProviderId: '',
    sttModelId: '',
    llmProviderId: '',
    llmModelId: '',
    answerMode: 'natural',
    timings: { encodeMs: 0, transcribeMs: 0, totalMs: 0 },
  });

  it('keeps items inside the window and drops the rest', () => {
    const kept = applyRetention([at(0.5), at(6), at(8), at(40)], 7);
    expect(kept.map((i) => i.id)).toEqual(['0.5', '6']);
  });

  it('retention 0 keeps nothing', () => {
    expect(applyRetention([at(0.01)], 0)).toEqual([]);
  });

  it('drops items with unparseable dates', () => {
    const bad = { ...at(1), createdAt: 'not-a-date' };
    expect(applyRetention([bad], 30)).toEqual([]);
  });
});

describe('ProfileStore', () => {
  it('creates, updates, and deletes profiles', async () => {
    const store = new ProfileStore(dir);
    const created = await store.save({
      name: 'P1',
      summary: 's',
      roleContext: 'r',
      emphasisNotes: '',
    });
    expect(created.id).toBeTruthy();
    const updated = await store.save({ ...created, name: 'P1 renamed' });
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect((await store.list())[0].name).toBe('P1 renamed');
    await store.delete(created.id);
    expect(await store.list()).toEqual([]);
  });
});
