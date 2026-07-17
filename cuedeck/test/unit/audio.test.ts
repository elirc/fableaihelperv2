import { describe, expect, it } from 'vitest';
import {
  decodeWavToFloat32,
  downmixToMono,
  encodeWav,
  floatTo16BitPcm,
  parseWavHeader,
  peak,
  resample,
  rms,
} from '../../src/shared/audio';
import { sineWav, silentWav } from '../helpers/wav';

describe('downmixToMono', () => {
  it('averages stereo channels deterministically', () => {
    const left = new Float32Array([1, 0.5, -1]);
    const right = new Float32Array([0, 0.5, 1]);
    const mono = downmixToMono([left, right]);
    expect(Array.from(mono)).toEqual([0.5, 0.5, 0]);
  });

  it('passes mono through unchanged', () => {
    const input = new Float32Array([0.1, 0.2]);
    expect(downmixToMono([input])).toBe(input);
  });

  it('handles mismatched channel lengths by truncating to the shortest', () => {
    const mono = downmixToMono([new Float32Array([1, 1, 1]), new Float32Array([1, 1])]);
    expect(mono.length).toBe(2);
  });

  it('returns empty for no channels', () => {
    expect(downmixToMono([]).length).toBe(0);
  });

  it('averages three channels', () => {
    const mono = downmixToMono([
      new Float32Array([0.9, 0.3]),
      new Float32Array([0.3, 0.3]),
      new Float32Array([0.3, 0.3]),
    ]);
    expect(mono[0]).toBeCloseTo(0.5, 5);
    expect(mono[1]).toBeCloseTo(0.3, 5);
  });
});

describe('resample', () => {
  it('halves length for 2:1 ratio', () => {
    const input = new Float32Array(48_000);
    expect(resample(input, 48_000, 16_000).length).toBe(16_000);
  });

  it('is identity at equal rates', () => {
    const input = new Float32Array([0.5, -0.5]);
    expect(resample(input, 16_000, 16_000)).toBe(input);
  });

  it('preserves a DC signal', () => {
    const input = new Float32Array(4_800).fill(0.25);
    const out = resample(input, 48_000, 16_000);
    for (const sample of out) expect(sample).toBeCloseTo(0.25, 5);
  });

  it('rejects non-positive rates', () => {
    expect(() => resample(new Float32Array(1), 0, 16_000)).toThrow();
    expect(() => resample(new Float32Array(1), 48_000, -1)).toThrow();
  });

  it('handles empty input', () => {
    expect(resample(new Float32Array(0), 48_000, 16_000).length).toBe(0);
  });

  it('upsamples with the expected length and preserves DC', () => {
    const input = new Float32Array(1_600).fill(-0.5);
    const out = resample(input, 16_000, 48_000);
    expect(out.length).toBe(4_800);
    for (const sample of out) expect(sample).toBeCloseTo(-0.5, 5);
  });

  it('preserves DC at a non-integer ratio (44.1 kHz to 16 kHz)', () => {
    const input = new Float32Array(4_410).fill(0.25);
    const out = resample(input, 44_100, 16_000);
    expect(out.length).toBe(1_600);
    for (const sample of out) expect(sample).toBeCloseTo(0.25, 5);
  });
});

describe('floatTo16BitPcm', () => {
  it('clamps out-of-range samples', () => {
    const pcm = floatTo16BitPcm(new Float32Array([2, -2, 1, -1]));
    expect(pcm[0]).toBe(0x7fff);
    expect(pcm[1]).toBe(-0x8000);
    expect(pcm[2]).toBe(0x7fff);
    expect(pcm[3]).toBe(-0x8000);
  });
});

describe('encodeWav / parseWavHeader / decodeWavToFloat32', () => {
  it('round-trips samples through the RIFF container', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 0.25]);
    const wav = encodeWav(samples, 16_000);
    const info = parseWavHeader(wav);
    expect(info.sampleRate).toBe(16_000);
    expect(info.channels).toBe(1);
    expect(info.bitsPerSample).toBe(16);
    const { samples: decoded, sampleRate } = decodeWavToFloat32(wav);
    expect(sampleRate).toBe(16_000);
    expect(decoded.length).toBe(4);
    for (let i = 0; i < 4; i++) expect(decoded[i]).toBeCloseTo(samples[i], 3);
  });

  it('reports duration correctly', () => {
    const info = parseWavHeader(sineWav(2));
    expect(info.durationMs).toBeCloseTo(2_000, 0);
  });

  it('rejects non-WAV bytes', () => {
    expect(() => parseWavHeader(new Uint8Array(100))).toThrow();
  });

  it('rejects truncated files', () => {
    expect(() => parseWavHeader(sineWav(1).slice(0, 20))).toThrow();
  });

  it('rejects a WAV whose data chunk is empty', () => {
    expect(() => parseWavHeader(encodeWav(new Float32Array(0), 16_000))).toThrow();
  });

  it('parses a Uint8Array view with a non-zero byteOffset', () => {
    const wav = sineWav(1);
    const padded = new Uint8Array(wav.length + 100);
    padded.set(wav, 50);
    const view = padded.subarray(50, 50 + wav.length);
    const info = parseWavHeader(view);
    expect(info.sampleRate).toBe(16_000);
    expect(info.durationMs).toBeCloseTo(1_000, 0);
    const { samples } = decodeWavToFloat32(view);
    const { samples: reference } = decodeWavToFloat32(wav);
    expect(samples.length).toBe(reference.length);
    expect(samples[100]).toBeCloseTo(reference[100], 6);
  });

  it('clamps a lying data-chunk size to the bytes actually present', () => {
    const wav = sineWav(1);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    view.setUint32(40, 0xffffffff, true); // claim ~4 GB of data
    const info = parseWavHeader(wav);
    expect(info.dataBytes).toBe(wav.length - 44);
    expect(info.durationMs).toBeCloseTo(1_000, 0);
  });

  it('decodes a stereo file by averaging interleaved channels', () => {
    // Interleave L=0.5, R=-0.5 frames, then relabel the mono header as stereo.
    const interleaved = new Float32Array(200);
    for (let i = 0; i < interleaved.length; i += 2) {
      interleaved[i] = 0.5;
      interleaved[i + 1] = -0.5;
    }
    const wav = encodeWav(interleaved, 16_000);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    view.setUint16(22, 2, true); // channels
    view.setUint32(28, 16_000 * 4, true); // byte rate
    view.setUint16(32, 4, true); // block align
    const info = parseWavHeader(wav);
    expect(info.channels).toBe(2);
    expect(info.durationMs).toBeCloseTo((100 / 16_000) * 1000, 3);
    const { samples } = decodeWavToFloat32(wav);
    expect(samples.length).toBe(100);
    for (const sample of samples) expect(sample).toBeCloseTo(0, 3);
  });

  it('rejects unsupported channel counts and sample rates', () => {
    const channels = sineWav(1);
    new DataView(channels.buffer, channels.byteOffset).setUint16(22, 3, true);
    expect(() => parseWavHeader(channels)).toThrow();
    const rate = sineWav(1);
    new DataView(rate.buffer, rate.byteOffset).setUint32(24, 4_000, true);
    expect(() => parseWavHeader(rate)).toThrow();
  });
});

describe('rms / peak', () => {
  it('detects silence', () => {
    const { samples } = decodeWavToFloat32(silentWav(1));
    expect(rms(samples)).toBe(0);
    expect(peak(samples)).toBe(0);
  });

  it('measures a sine wave near 1/sqrt(2) of amplitude', () => {
    const { samples } = decodeWavToFloat32(sineWav(1, 16_000, 0.5));
    expect(rms(samples)).toBeGreaterThan(0.3);
    expect(rms(samples)).toBeLessThan(0.4);
    expect(peak(samples)).toBeCloseTo(0.5, 1);
  });

  it('returns 0 for empty buffers instead of NaN', () => {
    expect(rms(new Float32Array(0))).toBe(0);
    expect(peak(new Float32Array(0))).toBe(0);
  });

  it('reports peak from negative excursions', () => {
    expect(peak(new Float32Array([0.1, -0.9, 0.2]))).toBeCloseTo(0.9, 6);
  });
});
