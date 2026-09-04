/**
 * Silence endpointing: decide, from the live level meter, when the speaker
 * has finished talking so the clip can be submitted without waiting for a
 * manual Stop click. This is the single biggest latency saving in the whole
 * pipeline — it removes human reaction time from every exchange.
 *
 * It also flags silence *onset* well before it fires: the caller can start
 * transcribing the clip-so-far speculatively at that point, so the
 * trailing-silence wait overlaps real work instead of being dead time.
 *
 * Pure and renderer-agnostic: it consumes the same (rms, elapsedMs) samples
 * the level meter already receives (~15 Hz from the capture worklet).
 */

export interface EndpointerConfig {
  /** Speech must total at least this long before auto-stop can arm. */
  minSpeechMs: number;
  /** Continuous silence after speech that triggers auto-stop. */
  trailingSilenceMs: number;
  /**
   * Continuous silence after speech at which a speculative transcription of
   * the audio so far should start. Must be below `trailingSilenceMs`; the
   * gap between the two is the time the transcriber gets for free.
   */
  speculateAfterMs: number;
  /**
   * Minimum clip growth between two speculations. Each snapshot re-encodes
   * and re-uploads the whole clip, so a pause that adds little new audio
   * over the previous snapshot is not worth another pass.
   */
  respeculateAfterMs: number;
  /** RMS at or above this counts as speech. */
  speechRms: number;
  /** RMS below this counts as silence; between the two, the previous
   *  state holds (hysteresis, so breathy trailing audio does not flap). */
  silenceRms: number;
}

/**
 * What one level sample means for the caller: nothing yet, start a
 * speculative transcription of the clip so far, or stop and submit.
 */
export type EndpointSignal = 'none' | 'speculate' | 'fire';

/**
 * Defaults tuned for system-loopback speech: ~1.2 s of speech to arm (so a
 * notification blip never triggers a submit), ~0.7 s of silence to start
 * speculating (longer than most mid-sentence breaths, so the snapshot is
 * usually the whole question), and ~1.6 s of trailing silence to fire (long
 * enough for a deliberate pause, short enough to feel instant when the
 * question actually ends), and ~3 s of new audio before a second snapshot
 * (with auto-respond off, every pause would otherwise re-upload the clip).
 */
export const ENDPOINT_DEFAULTS: EndpointerConfig = {
  minSpeechMs: 1_200,
  trailingSilenceMs: 1_600,
  speculateAfterMs: 700,
  respeculateAfterMs: 3_000,
  speechRms: 0.004,
  silenceRms: 0.002,
};

export class SilenceEndpointer {
  private speechMs = 0;
  private silenceMs = 0;
  private lastElapsedMs = 0;
  private inSpeech = false;
  private speculated = false;
  private lastSpeculateAt = Number.NEGATIVE_INFINITY;
  private fired = false;

  constructor(private readonly config: EndpointerConfig = ENDPOINT_DEFAULTS) {}

  /**
   * Feed one level sample. Returns true exactly once, at the moment the
   * trailing-silence condition is met; every later call returns false.
   */
  push(rms: number, elapsedMs: number): boolean {
    return this.pushDetailed(rms, elapsedMs) === 'fire';
  }

  /**
   * Feed one level sample and learn what to do: 'speculate' once per silence
   * run (after enough speech has accumulated), 'fire' exactly once, 'none'
   * otherwise. A silence run that is interrupted by speech re-arms the
   * speculation flag, so a second pause produces a second, fresher snapshot
   * — provided the clip has grown by `respeculateAfterMs` since the last one.
   */
  pushDetailed(rms: number, elapsedMs: number): EndpointSignal {
    if (this.fired) return 'none';
    const dt = Math.max(0, elapsedMs - this.lastElapsedMs);
    this.lastElapsedMs = elapsedMs;

    if (rms >= this.config.speechRms) this.inSpeech = true;
    else if (rms < this.config.silenceRms) this.inSpeech = false;

    if (this.inSpeech) {
      this.speechMs += dt;
      this.silenceMs = 0;
      this.speculated = false;
    } else {
      this.silenceMs += dt;
    }

    if (this.speechMs < this.config.minSpeechMs) return 'none';
    if (this.silenceMs >= this.config.trailingSilenceMs) {
      this.fired = true;
      return 'fire';
    }
    if (!this.speculated && this.silenceMs >= this.config.speculateAfterMs) {
      this.speculated = true;
      // Too little new audio since the last snapshot: this pause is skipped
      // outright rather than re-checked every tick as the silence lengthens.
      if (elapsedMs - this.lastSpeculateAt < this.config.respeculateAfterMs) return 'none';
      this.lastSpeculateAt = elapsedMs;
      return 'speculate';
    }
    return 'none';
  }
}
