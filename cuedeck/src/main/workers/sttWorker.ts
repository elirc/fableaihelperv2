/**
 * Local STT utility process. Loads a Whisper-compatible ONNX model with
 * Transformers.js and transcribes Float32 PCM sent from the main process.
 *
 * Runs via `utilityProcess.fork`; all communication goes through
 * `process.parentPort`. Cancellation is process-level: the manager kills
 * this process and respawns it, which also frees model memory.
 */

import { TARGET_SAMPLE_RATE } from '../../shared/constants';

interface LoadMessage {
  type: 'load';
  modelId: string;
  cacheDir: string;
}

interface TranscribeMessage {
  type: 'transcribe';
  id: number;
  audio: Float32Array;
  language?: string;
}

type InMessage = LoadMessage | TranscribeMessage;

type Transcriber = (
  audio: Float32Array,
  options: Record<string, unknown>,
) => Promise<{
  text: string;
  chunks?: Array<{ timestamp: [number, number | null]; text: string }>;
}>;

const parentPort = process.parentPort;

let transcriber: Transcriber | null = null;
let loading: Promise<void> | null = null;
/** Inferences run one at a time: two concurrent ONNX runs on one CPU just
 *  make each other slower, and the manager relies on FIFO completion. */
let inferenceQueue: Promise<unknown> = Promise.resolve();

function post(message: unknown): void {
  parentPort.postMessage(message);
}

function inferenceOptions(language?: string): Record<string, unknown> {
  const options: Record<string, unknown> = {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: true,
  };
  if (language && language !== 'auto') options.language = language;
  return options;
}

async function loadModel(modelId: string, cacheDir: string): Promise<void> {
  const transformers = await import('@huggingface/transformers');
  transformers.env.cacheDir = cacheDir;
  transformers.env.allowLocalModels = true;
  const pipe = await transformers.pipeline('automatic-speech-recognition', modelId, {
    dtype: 'q8',
    progress_callback: (info: unknown) => {
      const p = info as {
        status?: string;
        file?: string;
        progress?: number;
        loaded?: number;
        total?: number;
      };
      post({
        type: 'load-progress',
        status: p.status ?? '',
        file: p.file ?? '',
        progress: typeof p.progress === 'number' ? p.progress : undefined,
        loaded: p.loaded,
        total: p.total,
      });
    },
  });
  const loaded = pipe as unknown as Transcriber;
  // ONNX Runtime plans and compiles kernels on the first run, so the first
  // real inference is noticeably slower than steady state even with the
  // weights resident. One second of silence takes that hit here, while the
  // clip is still being recorded, instead of inside "Transcribing…".
  try {
    await loaded(new Float32Array(TARGET_SAMPLE_RATE), inferenceOptions());
  } catch {
    // A failed warm run is not a failed load; the real request reports.
  }
  transcriber = loaded;
}

function transcribe(msg: TranscribeMessage): Promise<void> {
  const run = inferenceQueue.then(
    () => transcribeNow(msg),
    () => transcribeNow(msg),
  );
  inferenceQueue = run.catch(() => undefined);
  return run;
}

async function transcribeNow(msg: TranscribeMessage): Promise<void> {
  try {
    if (loading) await loading;
    if (!transcriber) throw new Error('model not loaded');
    const result = await transcriber(msg.audio, inferenceOptions(msg.language));
    post({
      type: 'transcript',
      id: msg.id,
      text: result.text ?? '',
      segments: (result.chunks ?? []).map((c) => ({
        startMs: Math.round((c.timestamp[0] ?? 0) * 1000),
        endMs: Math.round((c.timestamp[1] ?? c.timestamp[0] ?? 0) * 1000),
        text: c.text,
      })),
    });
  } catch (err) {
    post({
      type: 'transcribe-error',
      id: msg.id,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

parentPort.on('message', (event: { data: InMessage }) => {
  const msg = event.data;
  if (msg.type === 'load') {
    loading = loadModel(msg.modelId, msg.cacheDir)
      .then(() => post({ type: 'loaded', modelId: msg.modelId }))
      .catch((err: unknown) => {
        post({ type: 'load-error', detail: err instanceof Error ? err.message : String(err) });
      });
    return;
  }
  if (msg.type === 'transcribe') {
    void transcribe(msg);
  }
});

post({ type: 'worker-ready' });
