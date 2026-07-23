/**
 * Silence endpointing: decide, from the live level meter, when the speaker
 * has finished talking so the clip can be submitted without waiting for a
 * manual Stop click. This is the single biggest latency saving in the whole
 * pipeline — it removes human reaction time from every exchange.
 *
 * Pure and renderer-agnostic: it consumes the same (rms, elapsedMs) samples
 * the level meter already receives (~15 Hz from the capture worklet).
 */

export interface EndpointerConfig {
  /** Speech must total at least this long before auto-stop can arm. */
  minSpeechMs: number;
  /** Continuous silence after speech that triggers auto-stop. */
  trailingSilenceMs: number;
  /** RMS at or above this counts as speech. */
  speechRms: number;
  /** RMS below this counts as silence; between the two, the previous
   *  state holds (hysteresis, so breathy trailing audio does not flap). */
  silenceRms: number;
}

/**
 * Defaults tuned for system-loopback speech: ~1.2 s of speech to arm (so a
 * notification blip never triggers a submit) and ~1.6 s of trailing silence
 * to fire (long enough for a mid-sentence breath, short enough to feel
 * instant when the question actually ends).
 */
export const ENDPOINT_DEFAULTS: EndpointerConfig = {
  minSpeechMs: 1_200,
  trailingSilenceMs: 1_600,
  speechRms: 0.004,
  silenceRms: 0.002,
};

export class SilenceEndpointer {
  private speechMs = 0;
  private silenceMs = 0;
  private lastElapsedMs = 0;
  private inSpeech = false;
  private fired = false;

  constructor(private readonly config: EndpointerConfig = ENDPOINT_DEFAULTS) {}

  /**
   * Feed one level sample. Returns true exactly once, at the moment the
   * trailing-silence condition is met; every later call returns false.
   */
  push(rms: number, elapsedMs: number): boolean {
    if (this.fired) return false;
    const dt = Math.max(0, elapsedMs - this.lastElapsedMs);
    this.lastElapsedMs = elapsedMs;

    if (rms >= this.config.speechRms) this.inSpeech = true;
    else if (rms < this.config.silenceRms) this.inSpeech = false;

    if (this.inSpeech) {
      this.speechMs += dt;
      this.silenceMs = 0;
    } else {
      this.silenceMs += dt;
    }

    if (
      this.speechMs >= this.config.minSpeechMs &&
      this.silenceMs >= this.config.trailingSilenceMs
    ) {
      this.fired = true;
      return true;
    }
    return false;
  }
}
