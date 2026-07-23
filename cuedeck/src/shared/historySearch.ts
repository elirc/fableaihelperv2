import type { HistoryItem } from './domain';

/**
 * Case-insensitive multi-term filter for the history view. Terms are
 * whitespace-separated and must all match (AND), each anywhere in the
 * transcript or answer text — not IDs or provider names, which would make
 * "gemini" match every session run on that provider.
 */
export function filterHistory(items: HistoryItem[], query: string): HistoryItem[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return items;
  return items.filter((item) => {
    const haystack = `${item.transcript}\n${item.answer}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
