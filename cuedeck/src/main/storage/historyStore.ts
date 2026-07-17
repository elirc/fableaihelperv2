import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HistoryItem } from '../../shared/domain';
import { historyItemSchema } from '../../shared/schemas';
import { readJsonFile, writeJsonFile } from '../storage/jsonFile';

/** Local-only session history (spec §9.5). Off by default; no raw audio. */
export class HistoryStore {
  private readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(userDataDir: string) {
    this.filePath = path.join(userDataDir, 'history.json');
  }

  /**
   * Serialize read-modify-write cycles. `add` is fired-and-forgotten by the
   * coordinator, so without this a concurrent `clear`/`delete` from the
   * renderer could interleave and resurrect items the user just removed.
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async read(): Promise<HistoryItem[]> {
    const raw = await readJsonFile(this.filePath).catch(() => null);
    if (!Array.isArray(raw)) return [];
    const items: HistoryItem[] = [];
    for (const entry of raw) {
      const parsed = historyItemSchema.safeParse(entry);
      if (parsed.success) items.push(parsed.data);
    }
    return items;
  }

  async add(item: Omit<HistoryItem, 'id' | 'createdAt'>, retentionDays: number): Promise<void> {
    await this.enqueue(async () => {
      const items = await this.read();
      items.unshift({ ...item, id: randomUUID(), createdAt: new Date().toISOString() });
      await writeJsonFile(this.filePath, applyRetention(items, retentionDays));
    });
  }

  async list(limit: number, retentionDays: number): Promise<HistoryItem[]> {
    const items = applyRetention(await this.read(), retentionDays);
    return items.slice(0, limit);
  }

  async delete(id: string): Promise<void> {
    await this.enqueue(async () => {
      const items = await this.read();
      await writeJsonFile(
        this.filePath,
        items.filter((i) => i.id !== id),
      );
    });
  }

  async clear(): Promise<void> {
    await this.enqueue(() => writeJsonFile(this.filePath, []));
  }

  async exportAll(): Promise<HistoryItem[]> {
    return this.read();
  }
}

/** Drop items older than the retention window. 0 means "session only" — nothing kept. */
export function applyRetention(
  items: HistoryItem[],
  retentionDays: number,
  now: Date = new Date(),
): HistoryItem[] {
  if (retentionDays === 0) return [];
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  return items.filter((i) => {
    const t = Date.parse(i.createdAt);
    return Number.isFinite(t) && t >= cutoff;
  });
}
