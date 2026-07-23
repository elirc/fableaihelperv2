/**
 * Built-in practice question deck. Entirely local and static: drawing a
 * question only fills the editable transcript, so the whole practice flow
 * works offline and reuses the existing regenerate pipeline. The deck deals
 * every question once in random order before reshuffling, and never deals
 * the same question twice in a row (when more than one is available).
 */

export type PracticeCategory =
  'background' | 'behavioral' | 'motivation' | 'teamwork' | 'curveball';

export interface PracticeQuestion {
  id: string;
  category: PracticeCategory;
  text: string;
}

/** Category choices as shown in the UI; 'all' merges the whole bank. */
export const PRACTICE_CATEGORIES: Array<{ id: PracticeCategory | 'all'; label: string }> = [
  { id: 'all', label: 'All categories' },
  { id: 'background', label: 'Background' },
  { id: 'behavioral', label: 'Behavioral' },
  { id: 'motivation', label: 'Motivation' },
  { id: 'teamwork', label: 'Teamwork' },
  { id: 'curveball', label: 'Curveballs' },
];

export const PRACTICE_QUESTIONS: readonly PracticeQuestion[] = [
  // background
  { id: 'bg-yourself', category: 'background', text: 'Tell me about yourself.' },
  { id: 'bg-walkthrough', category: 'background', text: 'Walk me through your background.' },
  { id: 'bg-current-role', category: 'background', text: 'What do you do in your current role?' },
  {
    id: 'bg-proud',
    category: 'background',
    text: 'What accomplishment are you most proud of, and why?',
  },
  { id: 'bg-strengths', category: 'background', text: 'What are your greatest strengths?' },
  {
    id: 'bg-weakness',
    category: 'background',
    text: 'What is a weakness you are actively working on?',
  },
  // behavioral
  {
    id: 'bh-disagree',
    category: 'behavioral',
    text: 'Tell me about a time you disagreed with a teammate. How did you handle it?',
  },
  {
    id: 'bh-failure',
    category: 'behavioral',
    text: 'Describe a project that did not go as planned. What did you learn?',
  },
  {
    id: 'bh-deadline',
    category: 'behavioral',
    text: 'Tell me about a time you had to deliver under a tight deadline.',
  },
  {
    id: 'bh-learn-fast',
    category: 'behavioral',
    text: 'Describe a situation where you had to learn something new quickly.',
  },
  {
    id: 'bh-hard-decision',
    category: 'behavioral',
    text: 'Tell me about a difficult decision you made with incomplete information.',
  },
  {
    id: 'bh-feedback',
    category: 'behavioral',
    text: 'Tell me about a time you received hard feedback. What did you do next?',
  },
  // motivation
  { id: 'mo-why-role', category: 'motivation', text: 'Why do you want this role?' },
  {
    id: 'mo-why-leaving',
    category: 'motivation',
    text: 'Why are you looking to leave your current position?',
  },
  {
    id: 'mo-five-years',
    category: 'motivation',
    text: 'Where do you see yourself in five years?',
  },
  {
    id: 'mo-environment',
    category: 'motivation',
    text: 'What kind of work environment helps you do your best work?',
  },
  {
    id: 'mo-why-you',
    category: 'motivation',
    text: 'Why should we choose you over other candidates?',
  },
  {
    id: 'mo-questions',
    category: 'motivation',
    text: 'What questions do you have for us?',
  },
  // teamwork
  { id: 'tw-conflict', category: 'teamwork', text: 'How do you handle conflict on a team?' },
  {
    id: 'tw-struggling',
    category: 'teamwork',
    text: 'Tell me about a time you helped a struggling teammate.',
  },
  {
    id: 'tw-style-clash',
    category: 'teamwork',
    text: 'Describe working with someone whose style was very different from yours.',
  },
  {
    id: 'tw-role',
    category: 'teamwork',
    text: 'What role do you naturally take in a group?',
  },
  {
    id: 'tw-critical-feedback',
    category: 'teamwork',
    text: 'How do you give critical feedback to a peer?',
  },
  {
    id: 'tw-outside-comms',
    category: 'teamwork',
    text: 'How do you keep people outside your team informed about your progress?',
  },
  // curveball
  {
    id: 'cb-changed-mind',
    category: 'curveball',
    text: 'What is something you have changed your mind about recently?',
  },
  {
    id: 'cb-stay-current',
    category: 'curveball',
    text: 'How do you stay current in your field?',
  },
  {
    id: 'cb-outside-work',
    category: 'curveball',
    text: 'What do you like to do outside of work?',
  },
  {
    id: 'cb-teach',
    category: 'curveball',
    text: 'Teach me something in one minute.',
  },
  {
    id: 'cb-interesting-problem',
    category: 'curveball',
    text: 'What is the most interesting problem you have worked on?',
  },
  {
    id: 'cb-free-day',
    category: 'curveball',
    text: 'If you had an extra free day every week, how would you use it?',
  },
];

/** Questions for one category, or the whole bank for 'all'. Returns a copy. */
export function questionsForCategory(category: PracticeCategory | 'all'): PracticeQuestion[] {
  if (category === 'all') return [...PRACTICE_QUESTIONS];
  return PRACTICE_QUESTIONS.filter((q) => q.category === category);
}

/**
 * Deals questions in random order without repeats until the pool is
 * exhausted, then reshuffles. `rng` is injectable (return [0, 1)) so tests
 * can pin the order deterministically.
 */
export class PracticeDeck {
  private pool: PracticeQuestion[] = [];
  private lastDealtId: string | null = null;
  private readonly bank: PracticeQuestion[];

  constructor(
    category: PracticeCategory | 'all',
    private readonly rng: () => number = Math.random,
  ) {
    this.bank = questionsForCategory(category);
    if (this.bank.length === 0) throw new Error(`empty practice category: ${category}`);
  }

  /** Total questions in this deck's category. */
  get size(): number {
    return this.bank.length;
  }

  /** Questions left before the next reshuffle. */
  get remaining(): number {
    return this.pool.length;
  }

  draw(): PracticeQuestion {
    if (this.pool.length === 0) {
      this.pool = this.shuffle([...this.bank]);
      // Never repeat the previous question straight across a reshuffle.
      const next = this.pool[this.pool.length - 1];
      if (this.pool.length > 1 && next.id === this.lastDealtId) {
        const swapWith = Math.floor(this.rng() * (this.pool.length - 1));
        [this.pool[this.pool.length - 1], this.pool[swapWith]] = [
          this.pool[swapWith],
          this.pool[this.pool.length - 1],
        ];
      }
    }
    const question = this.pool.pop() as PracticeQuestion;
    this.lastDealtId = question.id;
    return question;
  }

  private shuffle(items: PracticeQuestion[]): PracticeQuestion[] {
    // Fisher-Yates with the injectable rng.
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }
}
