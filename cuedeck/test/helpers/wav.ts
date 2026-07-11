import { encodeWav } from '../../src/shared/audio';

/** Deterministic 440 Hz sine WAV fixture. */
export function sineWav(seconds: number, sampleRate = 16_000, amplitude = 0.4): Uint8Array {
  const samples = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  }
  return encodeWav(samples, sampleRate);
}

export function silentWav(seconds: number, sampleRate = 16_000): Uint8Array {
  return encodeWav(new Float32Array(Math.round(seconds * sampleRate)), sampleRate);
}
