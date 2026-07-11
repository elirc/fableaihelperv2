/**
 * Pure incremental parsers for provider streams. Both parsers are
 * chunk-boundary agnostic and flush any trailing frame at EOF, including
 * a final `data:` line that arrives without a newline (spec §5.3 item 5).
 */

export class SseParser {
  private buffer = '';
  private decoder = new TextDecoder();

  /** Feed a chunk; returns the `data:` payloads of any completed events. */
  push(chunk: Uint8Array | string): string[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    const events: string[] = [];
    let sep: { index: number; length: number } | null;
    while ((sep = findEventSeparator(this.buffer)) !== null) {
      const raw = this.buffer.slice(0, sep.index);
      this.buffer = this.buffer.slice(sep.index + sep.length);
      const data = extractData(raw);
      if (data !== null) events.push(data);
    }
    return events;
  }

  /** Flush the decoder and any unterminated final event. */
  end(): string[] {
    this.buffer += this.decoder.decode();
    const rest = this.buffer;
    this.buffer = '';
    if (rest.trim() === '') return [];
    const data = extractData(rest);
    return data === null ? [] : [data];
  }
}

function findEventSeparator(text: string): { index: number; length: number } | null {
  const candidates = [
    { index: text.indexOf('\r\n\r\n'), length: 4 },
    { index: text.indexOf('\n\n'), length: 2 },
    { index: text.indexOf('\r\r'), length: 2 },
  ].filter((c) => c.index !== -1);
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (b.index < a.index ? b : a));
}

function extractData(rawEvent: string): string | null {
  const lines = rawEvent.split(/\r\n|\n|\r/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0) return null;
  return dataLines.join('\n');
}

export class NdjsonParser {
  private buffer = '';
  private decoder = new TextDecoder();

  /** Feed a chunk; returns parsed objects for each complete line. */
  push(chunk: Uint8Array | string): unknown[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    const out: unknown[] = [];
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim() !== '') out.push(JSON.parse(line));
    }
    return out;
  }

  /** Flush a final line that arrived without a trailing newline. */
  end(): unknown[] {
    this.buffer += this.decoder.decode();
    const line = this.buffer.trim();
    this.buffer = '';
    return line === '' ? [] : [JSON.parse(line)];
  }
}

/**
 * Truncate to a maximum number of UTF-16 code units without splitting a
 * surrogate pair (spec §15.3).
 */
export function capText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let end = maxLength;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // don't strand a high surrogate
  return text.slice(0, end);
}
