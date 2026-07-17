import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Profile } from '../../shared/domain';
import { profileSchema } from '../../shared/schemas';
import { readJsonFile, writeJsonFile } from '../storage/jsonFile';

export class ProfileStore {
  private readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(userDataDir: string) {
    this.filePath = path.join(userDataDir, 'profiles.json');
  }

  /** Serialize read-modify-write cycles so concurrent saves/deletes (e.g. from two windows) cannot lose updates. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async list(): Promise<Profile[]> {
    const raw = await readJsonFile(this.filePath).catch(() => null);
    if (!Array.isArray(raw)) return [];
    const out: Profile[] = [];
    for (const entry of raw) {
      const parsed = profileSchema.safeParse(entry);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }

  async get(id: string): Promise<Profile | null> {
    return (await this.list()).find((p) => p.id === id) ?? null;
  }

  async save(
    input: Omit<Profile, 'id' | 'createdAt' | 'updatedAt'> & { id?: string },
  ): Promise<Profile> {
    return this.enqueue(async () => {
      const profiles = await this.list();
      const now = new Date().toISOString();
      const existing = input.id ? profiles.find((p) => p.id === input.id) : undefined;
      const profile: Profile = existing
        ? { ...existing, ...input, id: existing.id, updatedAt: now }
        : { ...input, id: input.id ?? randomUUID(), createdAt: now, updatedAt: now };
      const next = existing
        ? profiles.map((p) => (p.id === profile.id ? profile : p))
        : [...profiles, profile];
      await writeJsonFile(this.filePath, next);
      return profile;
    });
  }

  async delete(id: string): Promise<void> {
    await this.enqueue(async () => {
      const profiles = await this.list();
      await writeJsonFile(
        this.filePath,
        profiles.filter((p) => p.id !== id),
      );
    });
  }
}
