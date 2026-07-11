import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CoachError } from '../../shared/errors';

/** Read a JSON file, returning null when it does not exist. */
export async function readJsonFile(filePath: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new CoachError('STORAGE_FAILED', `reading ${path.basename(filePath)} failed`);
  }
}

/** Atomically write JSON: write to a temp file in the same directory, then rename. */
export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    // Windows can transiently lock the rename target (antivirus, indexer);
    // retry briefly before giving up.
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await fs.rename(tmp, filePath);
        return;
      } catch (err) {
        lastError = err;
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
    throw lastError;
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw new CoachError('STORAGE_FAILED', `writing ${path.basename(filePath)} failed`);
  }
}
