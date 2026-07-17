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

  it('handles CR-only separators', () => {
    const events = feedInChunks(new SseParser(), 'data: one\r\rdata: two\r\r', 2);
    expect(events).toEqual(['one', 'two']);
  });

  it('handles mixed separator styles within one stream', () => {
    const events = feedInChunks(new SseParser(), 'data: a\n\ndata: b\r\n\r\ndata: c\n\n', 4);
    expect(events).toEqual(['a', 'b', 'c']);
  });

  it('accepts data lines without a space after the colon', () => {
    const events = feedInChunks(new SseParser(), 'data:{"x":1}\n\n', 100);
    expect(events).toEqual(['{"x":1}']);
  });

  it('strips at most one leading space from the data value', () => {
    const events = feedInChunks(new SseParser(), 'data:  padded\n\n', 100);
    expect(events).toEqual([' padded']);
  });

  it('returns nothing at EOF when only a comment remains', () => {
    const parser = new SseParser();
    expect(parser.push(': keepalive')).toEqual([]);
    expect(parser.end()).toEqual([]);
  });

  it('returns nothing at EOF for an empty or whitespace-only buffer', () => {
    expect(new SseParser().end()).toEqual([]);
    const parser = new SseParser();
    parser.push('\n');
    expect(parser.end()).toEqual([]);
  });

  it('does not replay events after end() drains the buffer', () => {
    const parser = new SseParser();
    parser.push('data: tail');
    expect(parser.end()).toEqual(['tail']);
    expect(parser.end()).toEqual([]);
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

  it('buffers a JSON object split mid-token across pushes', () => {
    const parser = new NdjsonParser();
    expect(parser.push('{"text":"par')).toEqual([]);
    expect(parser.push('tial ✓"}\n')).toEqual([{ text: 'partial ✓' }]);
  });

  it('decodes multi-byte UTF-8 split across chunk boundaries', () => {
    const parser = new NdjsonParser();
    const bytes = encoder.encode('{"t":"héllo"}\n');
    const out: unknown[] = [];
    for (const byte of bytes) out.push(...parser.push(new Uint8Array([byte])));
    expect(out).toEqual([{ t: 'héllo' }]);
  });

  it('flushes a CRLF-terminated final line and ignores trailing whitespace at EOF', () => {
    const parser = new NdjsonParser();
    expect(parser.push('{"n":1}\r\n  ')).toEqual([{ n: 1 }]);
    expect(parser.end()).toEqual([]);
  });

  it('throws at end() when the trailing line is malformed', () => {
    const parser = new NdjsonParser();
    parser.push('{"n":1}\n{"broken');
    expect(() => parser.end()).toThrow();
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

  it('keeps a surrogate pair that ends exactly at the limit', () => {
    const capped = capText('ab\u{1F600}cd', 4);
    expect(capped).toBe('ab\u{1F600}');
    expect(() => encodeURIComponent(capped)).not.toThrow();
  });

  it('handles a zero-length cap', () => {
    expect(capText('abc', 0)).toBe('');
  });

  it('drops a leading high surrogate when the cap lands inside the first pair', () => {
    const capped = capText('\u{1F600}rest', 1);
    expect(capped).toBe('');
    expect(() => encodeURIComponent(capped)).not.toThrow();
  });
});
