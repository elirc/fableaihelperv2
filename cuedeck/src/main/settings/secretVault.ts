import path from 'node:path';
import { CoachError } from '../../shared/errors';
import { readJsonFile, writeJsonFile } from '../storage/jsonFile';

/**
 * Encrypted credential vault. Values are encrypted with Electron
 * `safeStorage` (DPAPI on Windows) and stored as base64 ciphertext in a
 * file separate from public settings. Secrets are write-only from the
 * renderer's perspective: nothing here is ever returned over IPC.
 */

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

interface VaultFile {
  version: 1;
  entries: Record<string, { ciphertext: string; encryptedAt: string }>;
}

export class SecretVault {
  private readonly filePath: string;

  constructor(
    userDataDir: string,
    private readonly safeStorage: SafeStorageLike,
  ) {
    this.filePath = path.join(userDataDir, 'secrets.json');
  }

  private async read(): Promise<VaultFile> {
    const raw = (await readJsonFile(this.filePath)) as VaultFile | null;
    if (!raw || raw.version !== 1 || typeof raw.entries !== 'object') {
      return { version: 1, entries: {} };
    }
    return raw;
  }

  async set(providerId: string, value: string): Promise<void> {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new CoachError('STORAGE_FAILED', 'OS credential encryption is unavailable');
    }
    const vault = await this.read();
    vault.entries[providerId] = {
      ciphertext: this.safeStorage.encryptString(value).toString('base64'),
      encryptedAt: new Date().toISOString(),
    };
    await writeJsonFile(this.filePath, vault);
  }

  async remove(providerId: string): Promise<void> {
    const vault = await this.read();
    delete vault.entries[providerId];
    await writeJsonFile(this.filePath, vault);
  }

  async has(providerId: string): Promise<boolean> {
    const vault = await this.read();
    return providerId in vault.entries;
  }

  /** Only provider adapters (main process) may call this. */
  async getForAdapter(providerId: string): Promise<string | null> {
    const vault = await this.read();
    const entry = vault.entries[providerId];
    if (!entry) return null;
    try {
      return this.safeStorage.decryptString(Buffer.from(entry.ciphertext, 'base64'));
    } catch {
      throw new CoachError('STORAGE_FAILED', 'stored credential could not be decrypted');
    }
  }
}
