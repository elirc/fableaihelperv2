/**
 * Pure audio helpers shared by the renderer (encode) and the main process
 * (validation). No Web Audio or Node APIs — everything here is testable
 * with plain typed arrays.
 */

/** Deterministic stereo→mono downmix: arithmetic mean per frame. */
export function downmixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const frames = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i];
    out[i] = sum / channels.length;
  }
  return out;
}

/**
 * Box-average resampler. Adequate for speech at 48 kHz→16 kHz; a windowed
 * sinc kernel is a post-MVP improvement (spec §5.4).
 */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  if (fromRate <= 0 || toRate <= 0) throw new Error('sample rates must be positive');
  const outLength = Math.max(0, Math.floor((input.length * toRate) / fromRate));
  const out = new Float32Array(outLength);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / (end - start);
  }
  return out;
}

/** Clamp to [-1, 1] and convert to 16-bit PCM. */
export function floatTo16BitPcm(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** Encode mono 16-bit PCM into a RIFF/WAVE container. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const pcm = floatTo16BitPcm(samples);
  const dataBytes = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  new Int16Array(buffer, 44).set(pcm);
  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** Parsed WAV header facts. Offsets/sizes in bytes, duration in milliseconds. */
export interface WavInfo {
  /** Samples per second (Hz). */
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Byte offset of the first PCM sample within the file. */
  dataOffset: number;
  /** PCM payload size in bytes, clamped to what is actually present. */
  dataBytes: number;
  durationMs: number;
}

/** Parse and validate a 16-bit PCM RIFF/WAVE header. Throws on malformed input. */
export function parseWavHeader(bytes: Uint8Array): WavInfo {
  if (bytes.length < 44) throw new Error('WAV too small');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  // Walk chunks to find fmt and data.
  let offset = 12;
  let fmt: { sampleRate: number; channels: number; bits: number; format: number } | null = null;
  let dataOffset = -1;
  let dataBytes = -1;
  while (offset + 8 <= bytes.length) {
    const id = readAscii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      if (offset + 8 + 16 > bytes.length) throw new Error('truncated fmt chunk');
      fmt = {
        format: view.getUint16(offset + 8, true),
        channels: view.getUint16(offset + 10, true),
        sampleRate: view.getUint32(offset + 12, true),
        bits: view.getUint16(offset + 22, true),
      };
    } else if (id === 'data') {
      dataOffset = offset + 8;
      dataBytes = Math.min(size, bytes.length - dataOffset);
    }
    offset += 8 + size + (size % 2);
  }
  if (!fmt) throw new Error('missing fmt chunk');
  if (dataOffset < 0 || dataBytes <= 0) throw new Error('missing data chunk');
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error('only 16-bit PCM supported');
  if (fmt.channels < 1 || fmt.channels > 2) throw new Error('unsupported channel count');
  if (fmt.sampleRate < 8_000 || fmt.sampleRate > 192_000)
    throw new Error('unsupported sample rate');
  // Floor: a truncated file can leave a partial final frame in dataBytes.
  const frames = Math.floor(dataBytes / (2 * fmt.channels));
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bits,
    dataOffset,
    dataBytes,
    durationMs: (frames / fmt.sampleRate) * 1000,
  };
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

/** Decode 16-bit PCM WAV data back to Float32 samples (mono downmixed). */
export function decodeWavToFloat32(bytes: Uint8Array): {
  samples: Float32Array;
  sampleRate: number;
} {
  const info = parseWavHeader(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset + info.dataOffset, info.dataBytes);
  // Floor: ignore a partial final frame rather than read past the DataView.
  const frames = Math.floor(info.dataBytes / (2 * info.channels));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < info.channels; c++) {
      sum = sum + view.getInt16((i * info.channels + c) * 2, true) / 0x8000;
    }
    samples[i] = sum / info.channels;
  }
  return { samples, sampleRate: info.sampleRate };
}

/** Root-mean-square level of a sample block. */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** Peak absolute level of a sample block. */
export function peak(samples: Float32Array): number {
  let max = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]);
    if (abs > max) max = abs;
  }
  return max;
}
