import { describe, expect, it } from 'vitest';
import type { HistoryItem } from '../../src/shared/domain';
import { filterHistory } from '../../src/shared/historySearch';

function item(id: string, transcript: string, answer: string): HistoryItem {
  return {
    id,
    createdAt: '2026-07-20T12:00:00.000Z',
    transcript,
    answer,
    sttProviderId: 'local-whisper',
    sttModelId: 'onnx-community/whisper-base',
    llmProviderId: 'gemini',
    llmModelId: 'gemini-2.5-flash',
    answerMode: 'natural',
    timings: { encodeMs: 10, transcribeMs: 500, totalMs: 2000 },
  };
}

const ITEMS = [
  item('1', 'Tell me about your background.', 'I spent six years on backend systems.'),
  item('2', 'Why do you want this role?', 'The platform work matches my C++ experience.'),
  item('3', 'Describe a production incident.', 'A migration locked the billing table.'),
];

describe('filterHistory', () => {
  it('returns all items for an empty query', () => {
    expect(filterHistory(ITEMS, '')).toEqual(ITEMS);
  });

  it('returns all items for a whitespace-only query', () => {
    expect(filterHistory(ITEMS, '   \t ')).toEqual(ITEMS);
  });

  it('matches case-insensitively in the transcript', () => {
    expect(filterHistory(ITEMS, 'BACKGROUND').map((i) => i.id)).toEqual(['1']);
  });

  it('matches case-insensitively in the answer', () => {
    expect(filterHistory(ITEMS, 'billing').map((i) => i.id)).toEqual(['3']);
  });

  it('requires every term to match (AND), across both fields', () => {
    // 'role' is in item 2's transcript, 'platform' in its answer.
    expect(filterHistory(ITEMS, 'role platform').map((i) => i.id)).toEqual(['2']);
    expect(filterHistory(ITEMS, 'role billing')).toEqual([]);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterHistory(ITEMS, 'kubernetes')).toEqual([]);
  });

  it('does not match provider or model identifiers', () => {
    // Every item ran on gemini; searching it must not return them all.
    expect(filterHistory(ITEMS, 'gemini')).toEqual([]);
    expect(filterHistory(ITEMS, 'whisper')).toEqual([]);
  });

  it('preserves the original item order', () => {
    expect(filterHistory(ITEMS, 'you').map((i) => i.id)).toEqual(['1', '2']);
  });

  it('treats regex metacharacters as literal text', () => {
    expect(filterHistory(ITEMS, 'c++').map((i) => i.id)).toEqual(['2']);
  });
});
