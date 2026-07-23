import { describe, expect, it } from 'vitest';
import {
  PRACTICE_CATEGORIES,
  PRACTICE_QUESTIONS,
  PracticeDeck,
  questionsForCategory,
  type PracticeCategory,
} from '../../src/shared/practice';

/** Deterministic rng: a tiny LCG so deck tests are reproducible. */
function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const REAL_CATEGORIES = PRACTICE_CATEGORIES.filter((c) => c.id !== 'all').map(
  (c) => c.id as PracticeCategory,
);

describe('practice question bank', () => {
  it('has globally unique question ids', () => {
    const ids = PRACTICE_QUESTIONS.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every question is non-empty, trimmed, and ends like a prompt', () => {
    for (const q of PRACTICE_QUESTIONS) {
      expect(q.text.trim()).toBe(q.text);
      expect(q.text.length).toBeGreaterThan(10);
      expect(q.text.length).toBeLessThan(200);
      expect(/[?.]$/.test(q.text)).toBe(true);
    }
  });

  it('every question belongs to a category listed in PRACTICE_CATEGORIES', () => {
    for (const q of PRACTICE_QUESTIONS) {
      expect(REAL_CATEGORIES).toContain(q.category);
    }
  });

  it('every category offers at least five questions', () => {
    for (const category of REAL_CATEGORIES) {
      expect(questionsForCategory(category).length).toBeGreaterThanOrEqual(5);
    }
  });
});

describe('questionsForCategory', () => {
  it("returns the whole bank for 'all'", () => {
    expect(questionsForCategory('all')).toHaveLength(PRACTICE_QUESTIONS.length);
  });

  it('returns only questions of the requested category', () => {
    const behavioral = questionsForCategory('behavioral');
    expect(behavioral.length).toBeGreaterThan(0);
    expect(behavioral.every((q) => q.category === 'behavioral')).toBe(true);
  });

  it('returns a copy — mutating the result does not corrupt the bank', () => {
    const before = PRACTICE_QUESTIONS.length;
    questionsForCategory('all').pop();
    expect(PRACTICE_QUESTIONS.length).toBe(before);
  });
});

describe('PracticeDeck', () => {
  it('deals every question exactly once before reshuffling', () => {
    const deck = new PracticeDeck('all', seededRng(7));
    const dealt = Array.from({ length: deck.size }, () => deck.draw().id);
    expect(new Set(dealt).size).toBe(deck.size);
  });

  it('keeps dealing after the pool is exhausted', () => {
    const deck = new PracticeDeck('behavioral', seededRng(3));
    const twoCycles = Array.from({ length: deck.size * 2 }, () => deck.draw().id);
    expect(twoCycles).toHaveLength(deck.size * 2);
    // Each cycle contains the full category.
    expect(new Set(twoCycles.slice(0, deck.size)).size).toBe(deck.size);
    expect(new Set(twoCycles.slice(deck.size)).size).toBe(deck.size);
  });

  it('never deals the same question twice in a row, across many reshuffles', () => {
    // Many seeds so a reshuffle whose top card equals the last dealt card
    // is actually exercised.
    for (let seed = 1; seed <= 25; seed++) {
      const deck = new PracticeDeck('background', seededRng(seed));
      let previous = '';
      for (let i = 0; i < deck.size * 4; i++) {
        const id = deck.draw().id;
        expect(id).not.toBe(previous);
        previous = id;
      }
    }
  });

  it('is deterministic for the same injected rng', () => {
    const a = new PracticeDeck('all', seededRng(42));
    const b = new PracticeDeck('all', seededRng(42));
    for (let i = 0; i < 10; i++) {
      expect(a.draw().id).toBe(b.draw().id);
    }
  });

  it('tracks size and remaining through a full cycle', () => {
    const deck = new PracticeDeck('motivation', seededRng(1));
    const size = deck.size;
    expect(deck.remaining).toBe(0); // nothing dealt yet, pool fills lazily
    deck.draw();
    expect(deck.remaining).toBe(size - 1);
    for (let i = 1; i < size; i++) deck.draw();
    expect(deck.remaining).toBe(0);
    deck.draw(); // triggers reshuffle
    expect(deck.remaining).toBe(size - 1);
    expect(deck.size).toBe(size);
  });
});
