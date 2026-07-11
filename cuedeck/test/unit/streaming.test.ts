import { describe, expect, it } from 'vitest';
import { capText, NdjsonParser, SseParser } from '../../src/shared/streaming';

const encoder = new TextEncoder();

function feedInChunks(parser: SseParser, text: string, chunkSize: number): string[] {
  const bytes = encoder.encode(text);
  const events: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    events.push(...parser.push(bytes.slice(i, i + chunkSize)));
  }
  events.push(...parser.end());
  return events;
}

describe('SseParser', () => {
  const stream = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n';

  it('parses events regardless of chunk boundaries', () => {
    for (let chunkSize = 1; chunkSize <= stream.length; chunkSize++) {
      const events = feedInChunks(new SseParser(), stream, chunkSize);
      expect(events).toEqual(['{"a":1}', '{"b":2}', '[DONE]']);
    }
  });

  it('handles CRLF separators', () => {
    const events = feedInChunks(new SseParser(), 'data: one\r\n\r\ndata: two\r\n\r\n', 3);
    expect(events).toEqual(['one', 'two']);
  });

  it('flushes a final data frame without a trailing newline (EOF edge case)', () => {
    const parser = new SseParser();
    const events = [...parser.push('data: {"a":1}\n\ndata: {"last":true}'), ...parser.end()];
    expect(events).toEqual(['{"a":1}', '{"last":true}']);
  });

  it('joins multi-line data fields', () => {
    const events = feedInChunks(new SseParser(), 'data: line1\ndata: line2\n\n', 100);
    expect(events).toEqual(['line1\nline2']);
  });

  it('ignores comments and other fields', () => {
    const events = feedInChunks(new SseParser(), ': keepalive\n\nevent: x\ndata: y\n\n', 100);
    expect(events).toEqual(['y']);
  });

  it('decodes multi-byte UTF-8 split across chunks', () => {
    const parser = new SseParser();
    const bytes = encoder.encode('data: héllo✓\n\n');
    const events: string[] = [];
    for (const byte of bytes) events.push(...parser.push(new Uint8Array([byte])));
    events.push(...parser.end());
    expect(events).toEqual(['héllo✓']);
  });
});

describe('NdjsonParser', () => {
  it('parses complete lines across chunk splits', () => {
    const text = '{"n":1}\n{"n":2}\r\n{"n":3}\n';
    for (let chunkSize = 1; chunkSize <= text.length; chunkSize++) {
      const parser = new NdjsonParser();
      const bytes = encoder.encode(text);
      const out: unknown[] = [];
      for (let i = 0; i < bytes.length; i += chunkSize) {
        out.push(...parser.push(bytes.slice(i, i + chunkSize)));
      }
      out.push(...parser.end());
      expect(out).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    }
  });

  it('flushes a final object without a newline', () => {
    const parser = new NdjsonParser();
    const out = [...parser.push('{"n":1}\n{"n":2}'), ...parser.end()];
    expect(out).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('skips blank lines', () => {
    const parser = new NdjsonParser();
    expect(parser.push('\n\n{"n":1}\n\n')).toEqual([{ n: 1 }]);
  });

  it('throws on malformed JSON lines', () => {
    const parser = new NdjsonParser();
    expect(() => parser.push('not json\n')).toThrow();
  });
});

describe('capText', () => {
  it('returns short text unchanged', () => {
    expect(capText('abc', 10)).toBe('abc');
  });

  it('truncates to the limit', () => {
    expect(capText('abcdef', 3)).toBe('abc');
  });

  it('never splits a surrogate pair', () => {
    const text = 'ab\u{1F600}cd'; // emoji is 2 UTF-16 code units at index 2-3
    const capped = capText(text, 3);
    expect(capped).toBe('ab');
    expect(() => encodeURIComponent(capped)).not.toThrow();
  });
});
