import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export type FakeHandler = (req: FakeRequest, res: http.ServerResponse) => void | Promise<void>;

export interface FakeServer {
  baseUrl: string;
  requests: FakeRequest[];
  close: () => Promise<void>;
  setHandler: (handler: FakeHandler) => void;
}

/** Loopback HTTP server for provider integration tests. */
export async function startFakeServer(handler: FakeHandler): Promise<FakeServer> {
  let current = handler;
  const requests: FakeRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const fake: FakeRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(fake);
      void current(fake, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
    setHandler: (h) => {
      current = h;
    },
  };
}

/** Write a body in odd-sized chunks with small delays to exercise buffering. */
export async function writeChunked(
  res: http.ServerResponse,
  body: string,
  chunkSize = 7,
): Promise<void> {
  for (let i = 0; i < body.length; i += chunkSize) {
    res.write(body.slice(i, i + chunkSize));
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  res.end();
}

/** Write a partial body, then sever the connection without a terminating chunk. */
export async function writeThenDestroy(
  res: http.ServerResponse,
  partialBody: string,
  delayMs = 30,
): Promise<void> {
  res.write(partialBody);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  res.destroy();
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

/** Drain an iterable expected to fail mid-way, keeping the items seen before the error. */
export async function collectUntilError<T>(
  iterable: AsyncIterable<T>,
): Promise<{ items: T[]; error: unknown }> {
  const items: T[] = [];
  try {
    for await (const item of iterable) items.push(item);
  } catch (error) {
    return { items, error };
  }
  throw new Error('expected the iterable to fail, but it completed');
}
