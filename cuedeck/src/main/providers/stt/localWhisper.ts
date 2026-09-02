import { LOCAL_STT_MODELS, PROVIDERS } from '../../../shared/catalog';
import { TARGET_SAMPLE_RATE, TIMEOUTS } from '../../../shared/constants';
import { decodeWavToFloat32, resample } from '../../../shared/audio';
import type { ModelSummary, ProviderProbe, TranscriptResult } from '../../../shared/domain';
import type { ModelProgress, SttWorkerManager } from '../../workers/sttWorkerManager';
import type { SttProvider, TranscribeInput } from '../contracts';

/**
 * Local Whisper STT via the Transformers.js utility process (spec §12.1).
 * Always free; audio never leaves the device.
 */
export class LocalWhisperProvider implements SttProvider {
  readonly meta = PROVIDERS['local-whisper'];

  constructor(
    private readonly workers: SttWorkerManager,
    private readonly getModelId: () => Promise<string>,
    private readonly onProgress: (p: ModelProgress) => void = () => undefined,
  ) {}

  async probe(): Promise<ProviderProbe> {
    const modelId = await this.getModelId();
    const installed = await this.workers.isInstalled(modelId);
    const models = await this.listModels();
    return {
      providerId: this.meta.id,
      status: installed ? 'ready' : 'missing-model',
      detail: installed ? undefined : `${modelId} has not been downloaded yet`,
      models,
    };
  }

  async listModels(): Promise<ModelSummary[]> {
    const out: ModelSummary[] = [];
    for (const model of LOCAL_STT_MODELS) {
      out.push({
        id: model.id,
        displayName: model.displayName,
        providerId: this.meta.id,
        sizeBytes: model.sizeBytes,
        license: model.license,
        installed: await this.workers.isInstalled(model.id),
      });
    }
    return out;
  }

  /**
   * Load the model into the worker while the clip is still recording. Only
   * an already-downloaded model is loaded: a warmup must never kick off a
   * multi-hundred-megabyte download the user did not ask for.
   */
  async warmup(modelId: string, signal: AbortSignal): Promise<void> {
    if (!(await this.workers.isInstalled(modelId))) return;
    await this.workers.ensureModel(modelId, () => undefined, signal);
  }

  async transcribe(input: TranscribeInput): Promise<TranscriptResult> {
    const audio = input.samples ?? decodeTo16k(input.audio);
    const timeout = AbortSignal.timeout(TIMEOUTS.localStt);
    const signal = AbortSignal.any([input.signal, timeout]);
    const result = await this.workers.transcribe({
      audio,
      modelId: input.modelId,
      language: input.language,
      signal,
      onProgress: this.onProgress,
    });
    return {
      ...result,
      text: result.text.trim(),
      durationMs: (audio.length / TARGET_SAMPLE_RATE) * 1000,
    };
  }
}

function decodeTo16k(wav: Uint8Array): Float32Array {
  const { samples, sampleRate } = decodeWavToFloat32(wav);
  return sampleRate === TARGET_SAMPLE_RATE
    ? samples
    : resample(samples, sampleRate, TARGET_SAMPLE_RATE);
}
