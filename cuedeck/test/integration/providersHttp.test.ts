import { afterEach, describe, expect, it } from 'vitest';
import { OllamaProvider } from '../../src/main/providers/llm/ollama';
import { GroqLlmProvider } from '../../src/main/providers/llm/groq';
import { GeminiLlmProvider } from '../../src/main/providers/llm/gemini';
import { OpenRouterProvider } from '../../src/main/providers/llm/openRouter';
import { GroqWhisperProvider } from '../../src/main/providers/stt/groqWhisper';
import { GeminiAudioProvider } from '../../src/main/providers/stt/geminiAudio';
import type { AnswerRequest } from '../../src/main/providers/contracts';
import { collect, startFakeServer, writeChunked, type FakeServer } from '../helpers/fakeServer';
import { sineWav } from '../helpers/wav';

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function server(handler: Parameters<typeof startFakeServer>[0]): Promise<FakeServer> {
  const s = await startFakeServer(handler);
  servers.push(s);
  return s;
}

function request(overrides: Partial<AnswerRequest> = {}): AnswerRequest {
  return {
    system: 'system prompt',
    user: 'user prompt',
    modelId: 'test-model',
    signal: new AbortController().signal,
    ...overrides,
  };
}

const key = async () => 'test-key-123';

describe('OllamaProvider', () => {
  it('discovers models via /api/tags and probes ready', async () => {
    const s = await server((req, res) => {
      if (req.url === '/api/tags') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ models: [{ name: 'qwen2.5:3b', size: 123 }] }));
      } else res.writeHead(404).end();
    });
    const provider = new OllamaProvider(async () => s.baseUrl);
    const probe = await provider.probe(new AbortController().signal);
    expect(probe.status).toBe('ready');
    expect(probe.models?.[0].id).toBe('qwen2.5:3b');
  });

  it('reports missing-model when no models are installed', async () => {
    const s = await server((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ models: [] }));
    });
    const probe = await new OllamaProvider(async () => s.baseUrl).probe(
      new AbortController().signal,
    );
    expect(probe.status).toBe('missing-model');
  });

  it('reports unreachable when the server is down', async () => {
    const s = await server((_req, res) => void res.end());
    await s.close();
    servers.pop();
    const probe = await new OllamaProvider(async () => s.baseUrl).probe(
      new AbortController().signal,
    );
    expect(probe.status).toBe('unreachable');
  });

  it('streams NDJSON chat deltas split across arbitrary chunks, flushing EOF without newline', async () => {
    const body =
      `${JSON.stringify({ message: { content: 'Hello ' }, done: false })}\n` +
      `${JSON.stringify({ message: { content: 'world' }, done: false })}\n` +
      JSON.stringify({ message: { content: '!' }, done: true }); // no trailing newline
    const s = await server((req, res) => {
      if (req.url === '/api/chat') {
        res.setHeader('content-type', 'application/x-ndjson');
        void writeChunked(res, body, 5);
      } else res.writeHead(404).end();
    });
    const deltas = await collect(new OllamaProvider(async () => s.baseUrl).generate(request()));
    expect(deltas.map((d) => d.text).join('')).toBe('Hello world!');
    expect(deltas.map((d) => d.sequence)).toEqual([0, 1, 2]);
  });

  it('maps 404 to MODEL_NOT_INSTALLED', async () => {
    const s = await server((_req, res) => void res.writeHead(404).end('{}'));
    await expect(
      collect(new OllamaProvider(async () => s.baseUrl).generate(request())),
    ).rejects.toThrow(/MODEL_NOT_INSTALLED/);
  });

  it('maps a connection failure to LOCAL_PROVIDER_UNREACHABLE', async () => {
    const s = await server((_req, res) => void res.end());
    await s.close();
    servers.pop();
    await expect(
      collect(new OllamaProvider(async () => s.baseUrl).generate(request())),
    ).rejects.toThrow(/LOCAL_PROVIDER_UNREACHABLE/);
  });

  it('aborts mid-stream when the signal fires', async () => {
    const controller = new AbortController();
    const s = await server(async (req, res) => {
      if (req.url === '/api/chat') {
        res.write(`${JSON.stringify({ message: { content: 'first' }, done: false })}\n`);
        controller.abort();
        // keep the connection open; the client should abort
        await new Promise((resolve) => setTimeout(resolve, 300));
        res.end();
      } else res.writeHead(404).end();
    });
    await expect(
      collect(
        new OllamaProvider(async () => s.baseUrl).generate(request({ signal: controller.signal })),
      ),
    ).rejects.toThrow();
  });

  it('sends system and user messages with think disabled', async () => {
    const s = await server((req, res) => {
      res.end(JSON.stringify({ message: { content: 'ok' }, done: true }));
      void req;
    });
    await collect(new OllamaProvider(async () => s.baseUrl).generate(request()));
    const sent = JSON.parse(s.requests[0].body.toString());
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'system prompt' });
    expect(sent.messages[1]).toEqual({ role: 'user', content: 'user prompt' });
    expect(sent.think).toBe(false);
    expect(sent.stream).toBe(true);
  });
});

describe('GroqLlmProvider (OpenAI-compatible SSE)', () => {
  const sse = (deltas: string[]) =>
    deltas
      .map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`)
      .join('') + 'data: [DONE]\n\n';

  it('streams deltas with monotonic sequences', async () => {
    const s = await server((req, res) => {
      expect(req.headers.authorization).toBe('Bearer test-key-123');
      res.setHeader('content-type', 'text/event-stream');
      void writeChunked(res, sse(['One ', 'two ', 'three']), 9);
    });
    const provider = new GroqLlmProvider(key, s.baseUrl);
    const deltas = await collect(provider.generate(request()));
    expect(deltas.map((d) => d.text).join('')).toBe('One two three');
    expect(deltas.map((d) => d.sequence)).toEqual([0, 1, 2]);
  });

  it('processes a final SSE frame with no trailing newline', async () => {
    const s = await server((_req, res) => {
      const body =
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'almost ' } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'done' } }] })}`; // EOF, no newline
      void writeChunked(res, body, 11);
    });
    const deltas = await collect(new GroqLlmProvider(key, s.baseUrl).generate(request()));
    expect(deltas.map((d) => d.text).join('')).toBe('almost done');
  });

  it('maps 401 to CREDENTIAL_REJECTED', async () => {
    const s = await server((_req, res) => void res.writeHead(401).end('{}'));
    await expect(collect(new GroqLlmProvider(key, s.baseUrl).generate(request()))).rejects.toThrow(
      /CREDENTIAL_REJECTED/,
    );
  });

  it('throws CREDENTIAL_MISSING without a key and never contacts the server', async () => {
    const s = await server((_req, res) => void res.end());
    await expect(
      collect(new GroqLlmProvider(async () => null, s.baseUrl).generate(request())),
    ).rejects.toThrow(/CREDENTIAL_MISSING/);
    expect(s.requests).toHaveLength(0);
  });

  it('honors a short Retry-After once on 429, then succeeds', async () => {
    let calls = 0;
    const s = await server((_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(429, { 'retry-after': '1' }).end();
      } else {
        res.end(sse(['recovered']));
      }
    });
    const deltas = await collect(new GroqLlmProvider(key, s.baseUrl).generate(request()));
    expect(calls).toBe(2);
    expect(deltas[0].text).toBe('recovered');
  });

  it('maps persistent 429 to PROVIDER_RATE_LIMITED', async () => {
    const s = await server((_req, res) => void res.writeHead(429).end());
    await expect(collect(new GroqLlmProvider(key, s.baseUrl).generate(request()))).rejects.toThrow(
      /PROVIDER_RATE_LIMITED/,
    );
  });

  it('maps 500 to PROVIDER_UNAVAILABLE', async () => {
    const s = await server((_req, res) => void res.writeHead(500).end());
    await expect(collect(new GroqLlmProvider(key, s.baseUrl).generate(request()))).rejects.toThrow(
      /PROVIDER_UNAVAILABLE/,
    );
  });

  it('tolerates malformed JSON frames without dying', async () => {
    const s = await server((_req, res) => {
      res.end(
        'data: not-json\n\n' +
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'good' } }] })}\n\n` +
          'data: [DONE]\n\n',
      );
    });
    const deltas = await collect(new GroqLlmProvider(key, s.baseUrl).generate(request()));
    expect(deltas.map((d) => d.text)).toEqual(['good']);
  });

  it('probe distinguishes ready / missing credential / rate limited', async () => {
    const s = await server((_req, res) => void res.end('{"data":[]}'));
    const provider = new GroqLlmProvider(key, s.baseUrl);
    expect((await provider.probe(new AbortController().signal)).status).toBe('ready');

    const noKey = new GroqLlmProvider(async () => null, s.baseUrl);
    expect((await noKey.probe(new AbortController().signal)).status).toBe('missing-credential');

    s.setHandler((_req, res) => void res.writeHead(429).end());
    expect((await provider.probe(new AbortController().signal)).status).toBe('quota-limited');
  });
});

describe('GroqWhisperProvider', () => {
  it('uploads multipart audio and normalizes the verbose response', async () => {
    const s = await server((req, res) => {
      expect(req.url).toBe('/audio/transcriptions');
      expect(req.headers['content-type']).toContain('multipart/form-data');
      expect(req.body.length).toBeGreaterThan(1000);
      res.end(
        JSON.stringify({
          text: ' Hello there. ',
          language: 'en',
          duration: 2,
          segments: [{ start: 0, end: 2, text: 'Hello there.' }],
        }),
      );
    });
    const provider = new GroqWhisperProvider(key, s.baseUrl);
    const result = await provider.transcribe({
      audio: sineWav(2),
      mimeType: 'audio/wav',
      modelId: 'whisper-large-v3-turbo',
      signal: new AbortController().signal,
    });
    expect(result.text).toBe('Hello there.');
    expect(result.language).toBe('en');
    expect(result.durationMs).toBe(2000);
    expect(result.segments?.[0]).toEqual({ startMs: 0, endMs: 2000, text: 'Hello there.' });
  });

  it('maps 401 to CREDENTIAL_REJECTED', async () => {
    const s = await server((_req, res) => void res.writeHead(401).end('{}'));
    await expect(
      new GroqWhisperProvider(key, s.baseUrl).transcribe({
        audio: sineWav(1),
        mimeType: 'audio/wav',
        modelId: 'whisper-large-v3-turbo',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/CREDENTIAL_REJECTED/);
  });
});

describe('GeminiAudioProvider / GeminiLlmProvider', () => {
  it('transcribes via generateContent with inline base64 audio', async () => {
    const s = await server((req, res) => {
      expect(req.url).toContain(':generateContent');
      expect(req.headers['x-goog-api-key']).toBe('test-key-123');
      const sent = JSON.parse(req.body.toString());
      expect(sent.contents[0].parts[1].inline_data.mime_type).toBe('audio/wav');
      expect(sent.contents[0].parts[1].inline_data.data.length).toBeGreaterThan(100);
      res.end(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: ' Transcribed text ' }] } }] }),
      );
    });
    const provider = new GeminiAudioProvider(key, s.baseUrl);
    const result = await provider.transcribe({
      audio: sineWav(1),
      mimeType: 'audio/wav',
      modelId: 'gemini-2.5-flash',
      signal: new AbortController().signal,
    });
    expect(result.text).toBe('Transcribed text');
  });

  it('streams answers via streamGenerateContent SSE', async () => {
    const s = await server((req, res) => {
      expect(req.url).toContain(':streamGenerateContent');
      const frames =
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Part one ' }] } }] })}\n\n` +
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'part two' }] } }] })}\n\n`;
      void writeChunked(res, frames, 13);
    });
    const deltas = await collect(new GeminiLlmProvider(key, s.baseUrl).generate(request()));
    expect(deltas.map((d) => d.text).join('')).toBe('Part one part two');
  });
});

describe('OpenRouterProvider', () => {
  it('lists only free models plus the free router', async () => {
    const s = await server((req, res) => {
      if (req.url === '/models') {
        res.end(
          JSON.stringify({
            data: [
              {
                id: 'meta/llama:free',
                name: 'Llama free',
                pricing: { prompt: '0', completion: '0' },
              },
              {
                id: 'anthropic/claude-sonnet',
                name: 'Paid',
                pricing: { prompt: '0.003', completion: '0.015' },
              },
              {
                id: 'sneaky/model:free',
                name: 'Sneaky',
                pricing: { prompt: '0.001', completion: '0' },
              },
            ],
          }),
        );
      } else res.writeHead(404).end();
    });
    const models = await new OpenRouterProvider(key, s.baseUrl).listModels(
      new AbortController().signal,
    );
    expect(models.map((m) => m.id)).toEqual(['openrouter/free', 'meta/llama:free']);
  });

  it('refuses to generate with a non-free model id', async () => {
    const s = await server((_req, res) => void res.end());
    await expect(
      collect(
        new OpenRouterProvider(key, s.baseUrl).generate(
          request({ modelId: 'anthropic/claude-sonnet' }),
        ),
      ),
    ).rejects.toThrow(/only free OpenRouter models/);
    expect(s.requests).toHaveLength(0);
  });

  it('streams from the free router', async () => {
    const s = await server((req, res) => {
      if (req.url === '/chat/completions') {
        res.end(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'free answer' } }] })}\n\ndata: [DONE]\n\n`,
        );
      } else res.writeHead(404).end();
    });
    const deltas = await collect(
      new OpenRouterProvider(key, s.baseUrl).generate(request({ modelId: 'openrouter/free' })),
    );
    expect(deltas[0].text).toBe('free answer');
  });
});
