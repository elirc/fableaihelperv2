import { describe, expect, it } from 'vitest';
import { ENDPOINT_DEFAULTS, SilenceEndpointer } from '../../src/shared/endpointing';

/**
 * Feed the endpointer a scripted sequence of levels the way the recorder
 * does: one sample every `stepMs`, rms per phase. Returns the elapsedMs at
 * which it fired, or null.
 */
function run(
  endpointer: SilenceEndpointer,
  phases: Array<{ ms: number; rms: number }>,
  stepMs = 66, // matches the ~15 Hz meter cadence
): number | null {
  let elapsed = 0;
  for (const phase of phases) {
    const end = elapsed + phase.ms;
    while (elapsed < end) {
      elapsed += stepMs;
      if (endpointer.push(phase.rms, elapsed)) return elapsed;
    }
  }
  return null;
}

const SPEECH = 0.05;
const SILENCE = 0.0005;

describe('SilenceEndpointer', () => {
  it('never fires on pure silence (no question was asked)', () => {
    const fired = run(new SilenceEndpointer(), [{ ms: 60_000, rms: SILENCE }]);
    expect(fired).toBeNull();
  });

  it('never fires while speech continues', () => {
    const fired = run(new SilenceEndpointer(), [{ ms: 60_000, rms: SPEECH }]);
    expect(fired).toBeNull();
  });

  it('fires after speech followed by the trailing-silence window', () => {
    const fired = run(new SilenceEndpointer(), [
      { ms: 5_000, rms: SPEECH },
      { ms: 10_000, rms: SILENCE },
    ]);
    expect(fired).not.toBeNull();
    // Fired within one meter tick of speech end + trailing window.
    expect(fired!).toBeGreaterThanOrEqual(5_000 + ENDPOINT_DEFAULTS.trailingSilenceMs);
    expect(fired!).toBeLessThan(5_000 + ENDPOINT_DEFAULTS.trailingSilenceMs + 200);
  });

  it('does not fire during a pause shorter than the trailing window', () => {
    const fired = run(new SilenceEndpointer(), [
      { ms: 5_000, rms: SPEECH },
      { ms: ENDPOINT_DEFAULTS.trailingSilenceMs - 500, rms: SILENCE },
      { ms: 5_000, rms: SPEECH },
    ]);
    expect(fired).toBeNull();
  });

  it('a resumed sentence resets the silence run before firing', () => {
    const fired = run(new SilenceEndpointer(), [
      { ms: 3_000, rms: SPEECH },
      { ms: 1_000, rms: SILENCE }, // breath
      { ms: 3_000, rms: SPEECH }, // continues talking
      { ms: 10_000, rms: SILENCE }, // real end
    ]);
    expect(fired).not.toBeNull();
    expect(fired!).toBeGreaterThanOrEqual(7_000 + ENDPOINT_DEFAULTS.trailingSilenceMs);
  });

  it('requires minimum speech before it can arm (a blip is not a question)', () => {
    const fired = run(new SilenceEndpointer(), [
      { ms: 300, rms: SPEECH }, // notification ding
      { ms: 60_000, rms: SILENCE },
    ]);
    expect(fired).toBeNull();
  });

  it('accumulates interrupted speech toward the minimum', () => {
    // Two 700 ms bursts total 1.4 s of speech >= minSpeechMs (1.2 s).
    const fired = run(new SilenceEndpointer(), [
      { ms: 700, rms: SPEECH },
      { ms: 500, rms: SILENCE },
      { ms: 700, rms: SPEECH },
      { ms: 10_000, rms: SILENCE },
    ]);
    expect(fired).not.toBeNull();
  });

  it('fires exactly once', () => {
    const endpointer = new SilenceEndpointer();
    let elapsed = 0;
    let fires = 0;
    const feed = (ms: number, rms: number) => {
      const end = elapsed + ms;
      while (elapsed < end) {
        elapsed += 66;
        if (endpointer.push(rms, elapsed)) fires += 1;
      }
    };
    feed(5_000, SPEECH);
    feed(30_000, SILENCE);
    expect(fires).toBe(1);
  });

  it('holds the previous state in the hysteresis band', () => {
    const config = ENDPOINT_DEFAULTS;
    const between = (config.speechRms + config.silenceRms) / 2;
    // Speech, then levels hovering between the thresholds: still "speech",
    // so no fire even after a long stretch.
    const fired = run(new SilenceEndpointer(config), [
      { ms: 3_000, rms: SPEECH },
      { ms: 10_000, rms: between },
    ]);
    expect(fired).toBeNull();
  });

  it('respects a custom configuration', () => {
    const fired = run(
      new SilenceEndpointer({
        minSpeechMs: 500,
        trailingSilenceMs: 400,
        speechRms: 0.01,
        silenceRms: 0.005,
      }),
      [
        { ms: 1_000, rms: 0.02 },
        { ms: 2_000, rms: 0.001 },
      ],
    );
    expect(fired).not.toBeNull();
    expect(fired!).toBeLessThan(1_600);
  });
});
