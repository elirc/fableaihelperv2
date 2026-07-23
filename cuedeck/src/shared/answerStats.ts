import { SPOKEN_WORDS_PER_SECOND } from './constants';

/**
 * Speaking-pace math for the coach view. The user picks a target speaking
 * time; these helpers turn a finished answer into "how long would this take
 * to say" so the card can show whether the draft fits the target. Pure and
 * shared so the estimate uses the same pace constant the prompt's word
 * target is built from.
 */

export type PaceVerdict = 'short' | 'on-target' | 'long';

export interface AnswerStats {
  words: number;
  /** Estimated seconds of speaking time at a natural pace, rounded. */
  seconds: number;
  verdict: PaceVerdict;
}

/**
 * Count speakable words: whitespace-separated tokens containing at least one
 * letter or digit, so markdown bullets, dashes, and bare punctuation from a
 * 'bullets'-mode answer do not inflate the count.
 */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

/** Words → seconds at the shared natural speaking pace, rounded. */
export function estimateSpokenSeconds(text: string): number {
  return Math.round(countWords(text) / SPOKEN_WORDS_PER_SECOND);
}

/**
 * Compare an estimate against the user's target. The tolerance is ±25% of
 * the target with a 5-second floor so the 15-second target does not flag
 * every answer that is a sentence off.
 */
export function comparePace(estimatedSeconds: number, targetSeconds: number): PaceVerdict {
  const tolerance = Math.max(5, targetSeconds * 0.25);
  if (estimatedSeconds < targetSeconds - tolerance) return 'short';
  if (estimatedSeconds > targetSeconds + tolerance) return 'long';
  return 'on-target';
}

/** Full stats for one answer, or null when there is nothing to measure. */
export function answerStats(text: string, targetSeconds: number): AnswerStats | null {
  const words = countWords(text);
  if (words === 0) return null;
  const seconds = Math.round(words / SPOKEN_WORDS_PER_SECOND);
  return { words, seconds, verdict: comparePace(seconds, targetSeconds) };
}
