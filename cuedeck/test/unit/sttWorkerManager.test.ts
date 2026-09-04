import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeJsonFile } from '../../src/main/storage/jsonFile';

/**
 * The STT worker manager owns a utility process; here that process is a
 * scripted in-memory fake so the manifest, cache-cleanup and in-flight
 * bookkeeping can be checked without Electron or a Whisper model.
 */

type Message = Record<string, unknown>;
type Script = (msg: Message, worker: FakeWorker) => void;

class FakeWorker extends EventEmitter {
  killed = false;
  constructor(private readonly script: () => Script) {
    super();
  }
  postMessage(msg: Message): void {
    this.script()(msg, this);
  }
  kill(): boolean {
    this.killed = true;
    // Electron reports the exit asynchronously, after kill() returns.
    setImmediate(() => this.emit('exit', 0));
    return true;
  }
}

const forks: FakeWorker[] = [];
let script: Script = () => undefined;

vi.mock('electron', () => ({
  utilityProcess: {
    fork: () => {
      const worker = new FakeWorker(() => script);
      forks.push(worker);
      return worker;
    },
  },
}));

const { SttWorkerManager, isCorruptCacheError } =
  await import('../../src/main/workers/sttWorkerManager');

const MODEL = 'org/model-a';
const OTHER = 'org/model-b';
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const never = new AbortController().signal;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cuedeck-stt-'));
  forks.length = 0;
  script = loadsAndTranscribes();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const modelDir = (modelId: string) => path.join(dir, ...modelId.split('/'));

/** Pretend a download already happened: files on disk plus a manifest entry. */
async function install(modelId: string, bytes = 64): Promise<void> {
  mkdirSync(modelDir(modelId), { recursive: true });
  const file = path.join(modelDir(modelId), 'model.onnx');
  writeFileSync(file, Buffer.alloc(bytes, 1));
  const manifestPath = path.join(dir, 'manifest.json');
  const existing: { version: number; models: unknown[] } = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : { version: 1, models: [] };
  existing.models.push({
    modelId,
    installedAt: new Date().toISOString(),
    files: [{ name: path.relative(dir, file), bytes }],
  });
  await writeJsonFile(manifestPath, existing);
}

/** A well-behaved worker: "downloads" on load, answers every transcribe after `inferenceMs`. */
function loadsAndTranscribes(
  options: { inferenceMs?: number; onLoad?: () => void; onTranscribe?: () => void } = {},
): Script {
  return (msg, worker) => {
    if (msg.type === 'load') {
      const target = modelDir(String(msg.modelId));
      if (!existsSync(target)) {
        mkdirSync(target, { recursive: true });
        writeFileSync(path.join(target, 'model.onnx'), Buffer.alloc(64, 1));
      }
      options.onLoad?.();
      setImmediate(() => worker.emit('message', { type: 'loaded', modelId: msg.modelId }));
    } else if (msg.type === 'transcribe') {
      options.onTranscribe?.();
      setTimeout(() => {
        if (!worker.killed) worker.emit('message', { type: 'transcript', id: msg.id, text: 'hi' });
      }, options.inferenceMs ?? 0);
    }
  };
}

function failsToLoad(detail: string, options: { partialFile?: boolean } = {}): Script {
  return (msg, worker) => {
    if (msg.type !== 'load') return;
    if (options.partialFile) {
      const target = modelDir(String(msg.modelId));
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, 'model.onnx'), Buffer.alloc(10, 1)); // truncated
    }
    setImmediate(() => worker.emit('message', { type: 'load-error', detail }));
  };
}

function transcribe(
  manager: InstanceType<typeof SttWorkerManager>,
  modelId = MODEL,
  signal = never,
) {
  return manager.transcribe({
    audio: new Float32Array(16_000),
    modelId,
    signal,
    onProgress: () => undefined,
  });
}

describe('SttWorkerManager: downloads only through the explicit flow', () => {
  it('transcribe refuses a model that is not installed instead of downloading it', async () => {
    const manager = new SttWorkerManager('worker.js', dir, 0);
    await expect(transcribe(manager)).rejects.toThrow(/MODEL_NOT_INSTALLED/);
    expect(forks).toHaveLength(0);
    expect(existsSync(modelDir(MODEL))).toBe(false);
  });

  it('ensureModel downloads, records the manifest, and transcribe then works', async () => {
    const manager = new SttWorkerManager('worker.js', dir, 0);
    const progress: string[] = [];
    await manager.ensureModel(MODEL, (p) => progress.push(p.stage), never);
    expect(await manager.isInstalled(MODEL)).toBe(true);
    expect((await transcribe(manager)).text).toBe('hi');
    expect(forks).toHaveLength(1);
  });

  it('a download that fails leaves no partial cache behind', async () => {
    script = failsToLoad('fetch failed', { partialFile: true });
    const manager = new SttWorkerManager('worker.js', dir, 0);
    await expect(manager.ensureModel(MODEL, () => undefined, never)).rejects.toThrow(
      /MODEL_NOT_INSTALLED/,
    );
    expect(existsSync(modelDir(MODEL))).toBe(false);
    expect(await manager.isInstalled(MODEL)).toBe(false);
    expect(manager.getStatus().state).toBe('idle');
  });

  it('a cancelled download kills the worker and clears the partial cache', async () => {
    script = (msg) => {
      if (msg.type !== 'load') return;
      mkdirSync(modelDir(MODEL), { recursive: true });
      writeFileSync(path.join(modelDir(MODEL), 'model.onnx'), Buffer.alloc(10, 1));
      // never answers: the download is "in progress"
    };
    const manager = new SttWorkerManager('worker.js', dir, 0);
    const controller = new AbortController();
    const load = manager.ensureModel(MODEL, () => undefined, controller.signal);
    await tick();
    controller.abort();
    await expect(load).rejects.toThrow(/abort/i);
    expect(forks[0].killed).toBe(true);
    expect(existsSync(modelDir(MODEL))).toBe(false);
  });

  it('an installed model whose files no longer parse is forgotten so the next download replaces it', async () => {
    await install(MODEL);
    script = failsToLoad('Failed to load model because protobuf parsing failed.');
    const manager = new SttWorkerManager('worker.js', dir, 0);
    await expect(manager.ensureModel(MODEL, () => undefined, never)).rejects.toThrow(
      /MODEL_NOT_INSTALLED/,
    );
    expect(await manager.isInstalled(MODEL)).toBe(false);
    expect(existsSync(modelDir(MODEL))).toBe(false);
    // The same failure on the transcribe path leaves the user with the
    // download action rather than a model that can never load again.
    await expect(transcribe(manager)).rejects.toThrow(/MODEL_NOT_INSTALLED/);
  });

  it('keeps an installed model when the load fails for a reason unrelated to its files', async () => {
    await install(MODEL);
    script = failsToLoad('out of memory');
    const manager = new SttWorkerManager('worker.js', dir, 0);
    await expect(manager.ensureModel(MODEL, () => undefined, never)).rejects.toThrow();
    expect(await manager.isInstalled(MODEL)).toBe(true);
    expect(existsSync(modelDir(MODEL))).toBe(true);
  });

  it('classifies cache-corruption messages and nothing else', () => {
    expect(isCorruptCacheError('protobuf parsing failed')).toBe(true);
    expect(isCorruptCacheError('Unexpected end of JSON input')).toBe(true);
    expect(isCorruptCacheError('out of memory')).toBe(false);
    expect(isCorruptCacheError('model worker exited during load')).toBe(false);
  });
});

describe('SttWorkerManager: in-flight inference is never killed', () => {
  it('the idle reclaim waits for a running inference, then releases the worker', async () => {
    await install(MODEL);
    script = loadsAndTranscribes({ inferenceMs: 120 });
    const manager = new SttWorkerManager('worker.js', dir, 40);
    const result = await transcribe(manager);
    expect(result.text).toBe('hi');
    expect(forks[0].killed).toBe(false);
    expect(manager.getStatus()).toEqual({ state: 'ready', modelId: MODEL });
    await tick(80);
    expect(forks[0].killed).toBe(true);
    expect(manager.getStatus().state).toBe('idle');
  });

  it('loading another model waits for the running inference instead of killing it', async () => {
    await install(MODEL);
    await install(OTHER);
    const order: string[] = [];
    let inferenceStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      inferenceStarted = resolve;
    });
    script = loadsAndTranscribes({
      inferenceMs: 80,
      onLoad: () => order.push('load'),
      onTranscribe: () => inferenceStarted(),
    });
    const manager = new SttWorkerManager('worker.js', dir, 0);
    const first = transcribe(manager).then((r) => {
      order.push('transcript');
      return r;
    });
    await started; // the worker is now busy with the inference
    const swap = manager.ensureModel(OTHER, () => undefined, never);
    await tick(10);
    expect(forks).toHaveLength(1); // still waiting on the inference
    expect((await first).text).toBe('hi');
    await swap;
    expect(order).toEqual(['load', 'transcript', 'load']);
    expect(forks).toHaveLength(2);
    expect(forks[0].killed).toBe(true);
    expect(manager.getStatus()).toEqual({ state: 'ready', modelId: OTHER });
    // The replacement survives the old worker's late 'exit' and serves requests.
    expect((await transcribe(manager, OTHER)).text).toBe('hi');
  });

  it('aborting a swap that is waiting on an inference detaches it without touching the worker', async () => {
    await install(MODEL);
    await install(OTHER);
    let inferenceStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      inferenceStarted = resolve;
    });
    script = loadsAndTranscribes({ inferenceMs: 60, onTranscribe: () => inferenceStarted() });
    const manager = new SttWorkerManager('worker.js', dir, 0);
    const first = transcribe(manager);
    await started; // the worker is now busy with the inference
    const controller = new AbortController();
    const swap = manager.ensureModel(OTHER, () => undefined, controller.signal);
    controller.abort();
    await expect(swap).rejects.toThrow(/abort/i);
    expect((await first).text).toBe('hi');
    expect(forks).toHaveLength(1);
    expect(forks[0].killed).toBe(false);
  });
});
