import { encodeWav, resample } from '../../shared/audio';
import { TARGET_SAMPLE_RATE } from '../../shared/constants';

export interface RecorderCallbacks {
  onLevel: (rms: number, peak: number, elapsedMs: number) => void;
  onAutoStop: () => void;
}

export interface EncodedClip {
  wav: ArrayBuffer;
  encodeMs: number;
  durationMs: number;
}

/** Thrown by start() when abort() won the race; callers map it like a denied grant. */
function abortedError(): DOMException {
  return new DOMException('capture aborted', 'AbortError');
}

/**
 * System-audio recorder (CAP-01..CAP-09). Capture starts only after the
 * caller has armed a one-use grant and the user pressed Listen. The
 * display-media video track Electron requires on Windows is stopped
 * immediately; only audio is retained, and all sample buffers are released
 * after `stop()` encodes the WAV.
 */
export class ClipRecorder {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worklet: AudioWorkletNode | null = null;
  private chunks: Float32Array[] = [];
  private startedAt = 0;
  private sampleRate = 48_000;
  private lastLevelPost = 0;
  private stopped = false;

  constructor(
    private readonly maxSeconds: number,
    private readonly callbacks: RecorderCallbacks,
  ) {}

  async start(): Promise<void> {
    // The armed grant in the main process supplies the source; this request
    // never shows a picker and fails closed when unarmed (CAPTURE_DENIED).
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    if (this.stopped) {
      // abort() ran while the request was pending (Esc during arming): the
      // source must be released here or it outlives the hidden indicator.
      for (const track of stream.getTracks()) track.stop();
      throw abortedError();
    }
    for (const track of stream.getVideoTracks()) track.stop();
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      for (const track of stream.getTracks()) track.stop();
      throw new Error('CAPTURE_NO_AUDIO');
    }
    this.stream = new MediaStream(audioTracks);
    this.context = new AudioContext();
    this.sampleRate = this.context.sampleRate;
    await this.context.audioWorklet.addModule('./audio-capture-worklet.js');
    if (this.stopped) {
      await this.teardown();
      throw abortedError();
    }
    const source = this.context.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(this.context, 'cuedeck-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
    });
    this.worklet.port.onmessage = (event: MessageEvent) => {
      if (this.stopped) return;
      const { samples, rms, peak } = event.data as {
        samples: Float32Array;
        rms: number;
        peak: number;
      };
      this.chunks.push(samples);
      const elapsedMs = performance.now() - this.startedAt;
      const now = performance.now();
      if (now - this.lastLevelPost > 66) {
        // ~15 Hz meter updates (spec §18)
        this.lastLevelPost = now;
        this.callbacks.onLevel(rms, peak, elapsedMs);
      }
      if (elapsedMs >= this.maxSeconds * 1000) {
        this.callbacks.onAutoStop();
      }
    };
    source.connect(this.worklet);
    this.startedAt = performance.now();
  }

  /**
   * Encode everything captured so far without stopping. Used for the
   * speculative transcription started at silence onset: the clip keeps
   * recording, and if the speaker turns out to be done, the final clip is
   * this snapshot plus trailing silence. Throws once the recorder has
   * stopped.
   */
  snapshot(): EncodedClip {
    if (this.stopped) throw new Error('recorder stopped');
    return this.encode();
  }

  /** Stop capture and encode the collected audio as 16 kHz mono WAV. */
  async stop(): Promise<EncodedClip> {
    const encodeStart = performance.now();
    await this.teardown();
    const clip = this.encode();
    this.chunks = []; // release capture buffers (CAP-09)
    return { ...clip, encodeMs: Math.round(performance.now() - encodeStart) };
  }

  /** Discard everything without producing a clip (CAP-05). */
  async abort(): Promise<void> {
    await this.teardown();
    this.chunks = [];
  }

  private encode(): EncodedClip {
    const encodeStart = performance.now();
    const merged = this.merge();
    const resampled = resample(merged, this.sampleRate, TARGET_SAMPLE_RATE);
    const wav = encodeWav(resampled, TARGET_SAMPLE_RATE);
    const buffer = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
    return {
      wav: buffer,
      encodeMs: Math.round(performance.now() - encodeStart),
      durationMs: (resampled.length / TARGET_SAMPLE_RATE) * 1000,
    };
  }

  /**
   * Concatenate the worklet's 128-frame chunks. The result replaces them so
   * repeated snapshots do not re-copy thousands of tiny arrays each time.
   */
  private merge(): Float32Array {
    if (this.chunks.length === 1) return this.chunks[0];
    const totalFrames = this.chunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Float32Array(totalFrames);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [merged];
    return merged;
  }

  private async teardown(): Promise<void> {
    this.stopped = true;
    if (this.worklet) {
      this.worklet.port.onmessage = null;
      this.worklet.disconnect();
      this.worklet = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.context) {
      await this.context.close().catch(() => undefined);
      this.context = null;
    }
  }
}
