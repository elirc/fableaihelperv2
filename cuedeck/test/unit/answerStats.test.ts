import { describe, expect, it } from 'vitest';
import {
  answerStats,
  comparePace,
  countWords,
  estimateSpokenSeconds,
} from '../../src/shared/answerStats';
import { SPOKEN_WORDS_PER_SECOND } from '../../src/shared/constants';

describe('countWords', () => {
  it('counts whitespace-separated words in a plain sentence', () => {
    expect(countWords('I led the migration of our billing system.')).toBe(8);
  });

  it('treats runs of spaces and newlines as one separator', () => {
    expect(countWords('one   two\n\nthree\t four')).toBe(4);
  });

  it('returns 0 for empty and whitespace-only text', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   \n\t ')).toBe(0);
  });

  it('ignores punctuation-only tokens such as dashes and bullets', () => {
    expect(countWords('- first point\n- second point')).toBe(4);
    expect(countWords('yes — absolutely')).toBe(2);
    expect(countWords('...')).toBe(0);
  });

  it('counts numbers as spoken words', () => {
    expect(countWords('cut latency by 40 percent')).toBe(5);
  });

  it('counts words with accented and non-ASCII letters', () => {
    expect(countWords('café résumé naïve')).toBe(3);
  });
});

describe('estimateSpokenSeconds', () => {
  it('returns 0 for empty text', () => {
    expect(estimateSpokenSeconds('')).toBe(0);
  });

  it('converts words to seconds at the shared pace constant', () => {
    const words = 75;
    const text = Array.from({ length: words }, (_, i) => `w${i}`).join(' ');
    expect(estimateSpokenSeconds(text)).toBe(Math.round(words / SPOKEN_WORDS_PER_SECOND));
  });

  it('rounds to the nearest whole second', () => {
    // 4 words / 2.5 = 1.6 -> 2
    expect(estimateSpokenSeconds('a1 b2 c3 d4')).toBe(2);
  });
});

describe('comparePace', () => {
  it('flags well-short and well-long answers', () => {
    expect(comparePace(5, 30)).toBe('short');
    expect(comparePace(60, 30)).toBe('long');
  });

  it('accepts answers within ±25% of the target', () => {
    expect(comparePace(23, 30)).toBe('on-target');
    expect(comparePace(30, 30)).toBe('on-target');
    expect(comparePace(37, 30)).toBe('on-target');
  });

  it('is exclusive just outside the tolerance band', () => {
    // target 30 -> tolerance 7.5 -> short below 22.5, long above 37.5
    expect(comparePace(22, 30)).toBe('short');
    expect(comparePace(38, 30)).toBe('long');
  });

  it('applies the 5-second tolerance floor for the 15-second target', () => {
    // 25% of 15 is 3.75, but the floor keeps 10 and 20 acceptable.
    expect(comparePace(10, 15)).toBe('on-target');
    expect(comparePace(20, 15)).toBe('on-target');
    expect(comparePace(9, 15)).toBe('short');
    expect(comparePace(21, 15)).toBe('long');
  });
});

describe('answerStats', () => {
  it('returns null when there is nothing to measure', () => {
    expect(answerStats('', 30)).toBeNull();
    expect(answerStats('—', 30)).toBeNull();
  });

  it('bundles words, seconds, and the verdict consistently', () => {
    const words = 75; // 30 s at 2.5 wps
    const text = Array.from({ length: words }, (_, i) => `w${i}`).join(' ');
    const stats = answerStats(text, 30);
    expect(stats).toEqual({ words, seconds: 30, verdict: 'on-target' });
  });
});
