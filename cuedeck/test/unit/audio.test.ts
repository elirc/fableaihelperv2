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
});
