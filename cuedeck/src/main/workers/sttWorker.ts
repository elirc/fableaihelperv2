/**
 * Local STT utility process. Loads a Whisper-compatible ONNX model with
 * Transformers.js and transcribes Float32 PCM sent from the main process.
 *
 * Runs via `utilityProcess.fork`; all communication goes through
 * `process.parentPort`. Cancellation is process-level: the manager kills
 * this process and respawns it, which also frees model memory.
 */

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

function post(message: unknown): void {
  parentPort.postMessage(message);
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
  transcriber = pipe as unknown as Transcriber;
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
    void (async () => {
      try {
        if (loading) await loading;
        if (!transcriber) throw new Error('model not loaded');
        const options: Record<string, unknown> = {
          chunk_length_s: 30,
          stride_length_s: 5,
          return_timestamps: true,
        };
        if (msg.language && msg.language !== 'auto') options.language = msg.language;
        const result = await transcriber(msg.audio, options);
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
    })();
  }
});

post({ type: 'worker-ready' });
