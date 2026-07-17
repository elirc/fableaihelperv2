import { utilityProcess, type UtilityProcess } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TranscriptResult, TranscriptSegment } from '../../shared/domain';
import { CoachError } from '../../shared/errors';
import { readJsonFile, writeJsonFile } from '../storage/jsonFile';

export interface ModelProgress {
  stage: 'downloading' | 'loading';
  file?: string;
  value?: number; // 0..100
}

interface ManifestEntry {
  modelId: string;
  installedAt: string;
  files: Array<{ name: string; bytes: number }>;
}

interface Manifest {
  version: 1;
  models: ManifestEntry[];
}

/**
 * Owns the STT utility process and the local model manifest.
 * Cancellation kills the process (which aborts any in-flight download or
 * inference) and the next request respawns it.
 */
export class SttWorkerManager {
  private worker: UtilityProcess | null = null;
  private loadedModelId: string | null = null;
  private nextRequestId = 1;
  private status: 'idle' | 'loading' | 'ready' = 'idle';

  constructor(
    private readonly workerPath: string,
    private readonly modelsDir: string,
  ) {}

  get manifestPath(): string {
    return path.join(this.modelsDir, 'manifest.json');
  }

  async readManifest(): Promise<Manifest> {
    const raw = (await readJsonFile(this.manifestPath).catch(() => null)) as Manifest | null;
    if (!raw || raw.version !== 1 || !Array.isArray(raw.models)) return { version: 1, models: [] };
    return raw;
  }

  async isInstalled(modelId: string): Promise<boolean> {
    const manifest = await this.readManifest();
    const entry = manifest.models.find((m) => m.modelId === modelId);
    if (!entry) return false;
    // Verify the recorded files are still present with the recorded sizes.
    for (const file of entry.files) {
      try {
        const stat = await fs.stat(path.join(this.modelsDir, file.name));
        if (stat.size !== file.bytes) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  async removeModel(modelId: string): Promise<void> {
    const manifest = await this.readManifest();
    manifest.models = manifest.models.filter((m) => m.modelId !== modelId);
    await writeJsonFile(this.manifestPath, manifest);
    await fs
      .rm(path.join(this.modelsDir, ...modelId.split('/')), { recursive: true, force: true })
      .catch(() => undefined);
    if (this.loadedModelId === modelId) this.stop();
  }

  getStatus(): { state: string; modelId: string | null } {
    return { state: this.status, modelId: this.loadedModelId };
  }

  private spawn(): UtilityProcess {
    if (this.worker) return this.worker;
    this.worker = utilityProcess.fork(this.workerPath, [], { serviceName: 'cuedeck-stt' });
    this.worker.on('exit', () => {
      this.worker = null;
      this.loadedModelId = null;
      this.status = 'idle';
    });
    return this.worker;
  }

  /** Kill the worker (freeing model memory); the next request respawns it. */
  stop(): void {
    if (this.worker) {
      this.worker.kill();
      this.worker = null;
    }
    this.loadedModelId = null;
    this.status = 'idle';
  }

  /**
   * Ensure the model is loaded in the worker; first load downloads it.
   * Progress is reported through `onProgress`; abort kills the worker.
   * Invariant: on any failure the half-loaded worker is killed (unless a
   * newer call already replaced it), so `getStatus` never sticks at
   * 'loading' and the next request starts from a clean process.
   */
  async ensureModel(
    modelId: string,
    onProgress: (p: ModelProgress) => void,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.loadedModelId === modelId && this.status === 'ready') return;
    // 'abort' does not fire for an already-aborted signal, so check first.
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    this.stop();
    const worker = this.spawn();
    this.status = 'loading';
    const wasInstalled = await this.isInstalled(modelId);
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          cleanup();
          reject(new DOMException('aborted', 'AbortError'));
        };
        const onMessage = (event: { data?: unknown } | unknown) => {
          const msg = ((event as { data?: unknown }).data ?? event) as Record<string, unknown>;
          if (msg.type === 'load-progress') {
            onProgress({
              stage: wasInstalled ? 'loading' : 'downloading',
              file: typeof msg.file === 'string' ? msg.file : undefined,
              value: typeof msg.progress === 'number' ? msg.progress : undefined,
            });
          } else if (msg.type === 'loaded') {
            cleanup();
            resolve();
          } else if (msg.type === 'load-error') {
            cleanup();
            reject(
              new CoachError('MODEL_NOT_INSTALLED', String(msg.detail ?? 'model load failed')),
            );
          }
        };
        const onExit = () => {
          cleanup();
          reject(new CoachError('MODEL_NOT_INSTALLED', 'model worker exited during load'));
        };
        const cleanup = () => {
          signal.removeEventListener('abort', onAbort);
          worker.removeListener('message', onMessage as never);
          worker.removeListener('exit', onExit);
        };
        if (signal.aborted) {
          reject(new DOMException('aborted', 'AbortError'));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        worker.on('message', onMessage as never);
        worker.on('exit', onExit);
        worker.postMessage({ type: 'load', modelId, cacheDir: this.modelsDir });
      });
    } catch (err) {
      if (this.worker === worker) this.stop();
      throw err;
    }
    this.loadedModelId = modelId;
    this.status = 'ready';
    if (!wasInstalled) await this.recordInstall(modelId);
  }

  private async recordInstall(modelId: string): Promise<void> {
    const files: Array<{ name: string; bytes: number }> = [];
    const modelDir = path.join(this.modelsDir, ...modelId.split('/'));
    const walk = async (dir: string): Promise<void> => {
      let entries: Array<{ name: string; isDirectory(): boolean }> = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else {
          const stat = await fs.stat(full);
          files.push({ name: path.relative(this.modelsDir, full), bytes: stat.size });
        }
      }
    };
    await walk(modelDir);
    const manifest = await this.readManifest();
    manifest.models = manifest.models.filter((m) => m.modelId !== modelId);
    manifest.models.push({ modelId, installedAt: new Date().toISOString(), files });
    await writeJsonFile(this.manifestPath, manifest);
  }

  /**
   * Transcribe Float32 PCM in the worker (loading the model first if
   * needed). Abort kills the worker process — the only way to interrupt an
   * in-flight inference — and the next request respawns it.
   */
  async transcribe(input: {
    audio: Float32Array;
    modelId: string;
    language?: string;
    signal: AbortSignal;
    onProgress: (p: ModelProgress) => void;
  }): Promise<TranscriptResult> {
    await this.ensureModel(input.modelId, input.onProgress, input.signal);
    const worker = this.worker;
    if (!worker) throw new CoachError('MODEL_NOT_INSTALLED', 'model worker unavailable');
    const id = this.nextRequestId++;
    return new Promise<TranscriptResult>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        // Only kill our own worker; a newer request may have replaced it.
        if (this.worker === worker) this.stop();
        reject(new DOMException('aborted', 'AbortError'));
      };
      const onMessage = (event: { data?: unknown } | unknown) => {
        const msg = ((event as { data?: unknown }).data ?? event) as Record<string, unknown>;
        if (msg.type === 'transcript' && msg.id === id) {
          cleanup();
          resolve({
            text: String(msg.text ?? ''),
            segments: (msg.segments as TranscriptSegment[] | undefined) ?? undefined,
          });
        } else if (msg.type === 'transcribe-error' && msg.id === id) {
          cleanup();
          reject(
            new CoachError('PROVIDER_UNAVAILABLE', String(msg.detail ?? 'transcription failed')),
          );
        }
      };
      const onExit = () => {
        cleanup();
        reject(new CoachError('PROVIDER_UNAVAILABLE', 'model worker exited'));
      };
      const cleanup = () => {
        input.signal.removeEventListener('abort', onAbort);
        worker.removeListener('message', onMessage as never);
        worker.removeListener('exit', onExit);
      };
      // 'abort' does not fire for an already-aborted signal, so check first;
      // otherwise a pre-cancelled session would run a full inference.
      if (input.signal.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      input.signal.addEventListener('abort', onAbort, { once: true });
      worker.on('message', onMessage as never);
      worker.on('exit', onExit);
      worker.postMessage({ type: 'transcribe', id, audio: input.audio, language: input.language });
    });
  }
}
