import { utilityProcess, type UtilityProcess } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { STT_WORKER_IDLE_MS } from '../../shared/constants';
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
 * A load failure that means the cached files themselves are bad (a
 * truncated .onnx, a half-written config.json) rather than a transient
 * problem. Transformers' file cache treats any existing file as complete,
 * so such a cache must be cleared before a retry can succeed.
 */
export function isCorruptCacheError(detail: string): boolean {
  // Deliberately no bare "invalid" or "parse": ORT reports transient failures
  // such as "Invalid argument: insufficient memory" and "Failed to parse
  // session options" with the same words, and a false positive deletes a
  // multi-hundred-megabyte download.
  return /protobuf|corrupt|malformed|truncat|unexpected end|invalid (model|file|onnx)/i.test(
    detail,
  );
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
  private inflight: { modelId: string; promise: Promise<void> } | null = null;
  /** Transcriptions run strictly one after another (see `transcribe`). */
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  /**
   * Inferences the worker is currently running. Killing the process while
   * this is non-zero would fail a real request, so the idle reclaim and a
   * model swap both wait for it to drain (see `waitForIdle`).
   */
  private activeRequests = 0;
  private drainWaiters: Array<() => void> = [];

  constructor(
    private readonly workerPath: string,
    private readonly modelsDir: string,
    private readonly idleMs: number = STT_WORKER_IDLE_MS,
  ) {}

  /**
   * (Re)start the idle clock. A resident Whisper model costs a few hundred
   * megabytes; after a long pause it is released, and the capture-arm
   * warmup brings it back during the next recording. An inference that is
   * still running when the clock fires simply restarts it.
   */
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.idleMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.activeRequests > 0) {
        this.touch();
        return;
      }
      if (this.status === 'ready') this.stop();
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  get manifestPath(): string {
    return path.join(this.modelsDir, 'manifest.json');
  }

  private modelDir(modelId: string): string {
    return path.join(this.modelsDir, ...modelId.split('/'));
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
    await this.forgetInstall(modelId);
    await this.clearCache(modelId);
    if (this.loadedModelId === modelId) this.stop();
  }

  /** Drop the manifest entry so `isInstalled` reports the model missing. */
  private async forgetInstall(modelId: string): Promise<void> {
    const manifest = await this.readManifest();
    if (!manifest.models.some((m) => m.modelId === modelId)) return;
    manifest.models = manifest.models.filter((m) => m.modelId !== modelId);
    await writeJsonFile(this.manifestPath, manifest);
  }

  /**
   * Delete the model's cache directory. A download that was interrupted
   * (worker killed mid-stream) leaves truncated files that Transformers'
   * cache would otherwise serve as complete on every later load.
   */
  private async clearCache(modelId: string): Promise<void> {
    await fs.rm(this.modelDir(modelId), { recursive: true, force: true }).catch(() => undefined);
  }

  getStatus(): { state: string; modelId: string | null } {
    return { state: this.status, modelId: this.loadedModelId };
  }

  private spawn(): UtilityProcess {
    if (this.worker) return this.worker;
    const child = utilityProcess.fork(this.workerPath, [], { serviceName: 'cuedeck-stt' });
    child.on('exit', () => {
      // 'exit' arrives asynchronously after kill(); by then a replacement
      // may already be loading and must not be forgotten.
      if (this.worker !== child) return;
      this.worker = null;
      this.loadedModelId = null;
      this.status = 'idle';
    });
    this.worker = child;
    return child;
  }

  /** Kill the worker (freeing model memory); the next request respawns it. */
  stop(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.worker) {
      this.worker.kill();
      this.worker = null;
    }
    this.loadedModelId = null;
    this.status = 'idle';
  }

  private beginRequest(): void {
    this.activeRequests += 1;
    this.touch();
  }

  private endRequest(): void {
    this.activeRequests -= 1;
    if (this.activeRequests > 0) return;
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** Resolve once no inference is running in the worker (or reject on abort). */
  private waitForIdle(signal: AbortSignal): Promise<void> {
    if (this.activeRequests === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.drainWaiters = this.drainWaiters.filter((w) => w !== onDrain);
        reject(new DOMException('aborted', 'AbortError'));
      };
      const onDrain = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.drainWaiters.push(onDrain);
    });
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
    // A warmup and a transcribe can ask for the same model back to back;
    // joining the in-flight load (instead of killing it and starting over)
    // is the whole point of warming up. The joiner's own abort only detaches
    // it — the original load keeps its lifecycle.
    if (this.inflight && this.inflight.modelId === modelId) {
      await this.joinInflight(this.inflight.promise, signal);
      return;
    }
    // A different model may be downloading (models:download); a warmup or
    // transcribe for another model must not kill that worker mid-download.
    // Wait for it to settle (its own failure is not ours), then proceed.
    while (this.inflight && this.inflight.modelId !== modelId) {
      await this.joinInflight(
        this.inflight.promise.catch(() => undefined),
        signal,
      );
    }
    if (this.loadedModelId === modelId && this.status === 'ready') return;
    const load = this.loadModel(modelId, onProgress, signal);
    this.inflight = { modelId, promise: load };
    try {
      await load;
    } finally {
      if (this.inflight?.promise === load) this.inflight = null;
    }
  }

  private joinInflight(promise: Promise<void>, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  private async loadModel(
    modelId: string,
    onProgress: (p: ModelProgress) => void,
    signal: AbortSignal,
  ): Promise<void> {
    // Replacing the worker kills whatever it is doing; let a running
    // inference finish first rather than failing a real request.
    await this.waitForIdle(signal);
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
      if (!wasInstalled) {
        // A download that did not complete (aborted, killed, or failed)
        // leaves partial files behind; start the next attempt clean.
        await this.clearCache(modelId);
      } else if (err instanceof CoachError && isCorruptCacheError(err.public.detail ?? '')) {
        // Installed by the manifest, but the files no longer parse: forget
        // it so the next download replaces the cache instead of reusing it.
        await this.forgetInstall(modelId);
        await this.clearCache(modelId);
      }
      throw err;
    }
    this.loadedModelId = modelId;
    this.status = 'ready';
    this.touch();
    if (!wasInstalled) await this.recordInstall(modelId);
  }

  private async recordInstall(modelId: string): Promise<void> {
    const files: Array<{ name: string; bytes: number }> = [];
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
    await walk(this.modelDir(modelId));
    const manifest = await this.readManifest();
    manifest.models = manifest.models.filter((m) => m.modelId !== modelId);
    manifest.models.push({ modelId, installedAt: new Date().toISOString(), files });
    await writeJsonFile(this.manifestPath, manifest);
  }

  /**
   * Transcribe Float32 PCM in the worker (loading the model first if
   * needed). Requests are serialized: a speculative pass and the real
   * submit can arrive back to back, and running two inferences at once on
   * one CPU only makes both slower. Abort kills the worker process — the
   * only way to interrupt an in-flight inference — and the next request
   * respawns it; a request that is aborted while still queued never
   * reaches the worker at all.
   *
   * Only an installed model is loaded here. A transcribe runs under the
   * stage timeout, which would kill a multi-hundred-megabyte download
   * halfway and leave a truncated cache; downloads go through the explicit
   * models:download flow (`ensureModel`) instead.
   */
  transcribe(input: {
    audio: Float32Array;
    modelId: string;
    language?: string;
    signal: AbortSignal;
    onProgress: (p: ModelProgress) => void;
  }): Promise<TranscriptResult> {
    const run = this.queue.then(
      () => this.transcribeNow(input),
      () => this.transcribeNow(input),
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async transcribeNow(input: {
    audio: Float32Array;
    modelId: string;
    language?: string;
    signal: AbortSignal;
    onProgress: (p: ModelProgress) => void;
  }): Promise<TranscriptResult> {
    if (input.signal.aborted) throw new DOMException('aborted', 'AbortError');
    const resident = this.loadedModelId === input.modelId && this.status === 'ready';
    // An explicit download of this very model may be in flight (the manifest
    // is written only when it completes); ensureModel joins it rather than
    // refusing a model the user is watching download.
    const downloading = this.inflight?.modelId === input.modelId;
    if (!resident && !downloading && !(await this.isInstalled(input.modelId))) {
      throw new CoachError('MODEL_NOT_INSTALLED', `${input.modelId} has not been downloaded`);
    }
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
          this.touch();
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
      let finished = false;
      const cleanup = () => {
        if (finished) return;
        finished = true;
        input.signal.removeEventListener('abort', onAbort);
        worker.removeListener('message', onMessage as never);
        worker.removeListener('exit', onExit);
        this.endRequest();
      };
      // 'abort' does not fire for an already-aborted signal, so check first;
      // otherwise a pre-cancelled session would run a full inference.
      if (input.signal.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      this.beginRequest();
      input.signal.addEventListener('abort', onAbort, { once: true });
      worker.on('message', onMessage as never);
      worker.on('exit', onExit);
      worker.postMessage({ type: 'transcribe', id, audio: input.audio, language: input.language });
    });
  }
}
