import { afterEach, describe, expect, it } from 'vitest';
import { CerebrasLlmProvider } from '../../src/main/providers/llm/cerebras';
import { GeminiLlmProvider, supportsDisabledThinking } from '../../src/main/providers/llm/gemini';
import { OllamaProvider } from '../../src/main/providers/llm/ollama';
import type { AnswerRequest } from '../../src/main/providers/contracts';
import { OLLAMA_KEEP_ALIVE } from '../../src/shared/constants';
import { collect, startFakeServer, writeChunked, type FakeServer } from '../helpers/fakeServer';

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
const signal = () => new AbortController().signal;

describe('Ollama latency behavior', () => {
  it('sends keep_alive with every chat request so the model stays resident', async () => {
    const body = `${JSON.stringify({ message: { content: 'hi' }, done: true })}\n`;
    const s = await server((req, res) => {
      if (req.url === '/api/chat') {
        res.setHeader('content-type', 'application/x-ndjson');
        void writeChunked(res, body);
      } else res.writeHead(404).end();
    });
    const provider = new OllamaProvider(async () => s.baseUrl);
    await collect(provider.generate(request({ modelId: 'qwen2.5:3b' })));
    const sent = JSON.parse(s.requests[0].body.toString()) as Record<string, unknown>;
    expect(sent.keep_alive).toBe(OLLAMA_KEEP_ALIVE);
  });

  it('warmup preloads the model with an empty messages array', async () => {
    const s = await server((req, res) => {
      if (req.url === '/api/chat') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ done: true }));
      } else res.writeHead(404).end();
    });
    const provider = new OllamaProvider(async () => s.baseUrl);
    await provider.warmup('qwen2.5:3b', signal());
    expect(s.requests).toHaveLength(1);
    const sent = JSON.parse(s.requests[0].body.toString()) as Record<string, unknown>;
    expect(sent.model).toBe('qwen2.5:3b');
    expect(sent.messages).toEqual([]);
    expect(sent.keep_alive).toBe(OLLAMA_KEEP_ALIVE);
  });
});

describe('Gemini thinking budget', () => {
  const sse = (text: string) =>
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n\n`;

  async function generateAndCapture(modelId: string): Promise<Record<string, unknown>> {
    const s = await server((req, res) => {
      if (req.url?.includes(':streamGenerateContent')) {
        res.setHeader('content-type', 'text/event-stream');
        void writeChunked(res, sse('answer'));
      } else res.writeHead(404).end();
    });
    const provider = new GeminiLlmProvider(key, s.baseUrl);
    await collect(provider.generate(request({ modelId })));
    return JSON.parse(s.requests[0].body.toString()) as Record<string, unknown>;
  }

  it('disables thinking for 2.5 Flash so the first token is not delayed', async () => {
    const sent = await generateAndCapture('gemini-2.5-flash');
    const config = sent.generationConfig as { thinkingConfig?: { thinkingBudget?: number } };
    expect(config.thinkingConfig?.thinkingBudget).toBe(0);
  });

  it('omits thinkingConfig for models that would reject it', async () => {
    const sent = await generateAndCapture('gemini-1.5-flash');
    const config = sent.generationConfig as { thinkingConfig?: unknown };
    expect(config.thinkingConfig).toBeUndefined();
  });

  it('classifies model families for thinking support', () => {
    expect(supportsDisabledThinking('gemini-2.5-flash')).toBe(true);
    expect(supportsDisabledThinking('gemini-2.5-flash-lite')).toBe(true);
    expect(supportsDisabledThinking('gemini-2.5-pro')).toBe(false);
    expect(supportsDisabledThinking('gemini-1.5-flash')).toBe(false);
  });

  it('warmup fetches model metadata with the API key and no body left open', async () => {
    const s = await server((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ name: 'models/gemini-2.5-flash' }));
    });
    const provider = new GeminiLlmProvider(key, s.baseUrl);
    await provider.warmup('gemini-2.5-flash', signal());
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0].url).toBe('/models/gemini-2.5-flash');
    expect(s.requests[0].headers['x-goog-api-key']).toBe('test-key-123');
  });
});

describe('CerebrasLlmProvider (descriptor-driven OpenAI-compatible)', () => {
  const sseBody =
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'Fast ' } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'answer' } }] })}\n\n` +
    `data: [DONE]\n\n`;

  it('streams chat completions with bearer auth', async () => {
    const s = await server((req, res) => {
      if (req.url === '/chat/completions') {
        res.setHeader('content-type', 'text/event-stream');
        void writeChunked(res, sseBody);
      } else res.writeHead(404).end();
    });
    const provider = new CerebrasLlmProvider(key, s.baseUrl);
    const deltas = await collect(provider.generate(request({ modelId: 'llama3.1-8b' })));
    expect(deltas.map((d) => d.text).join('')).toBe('Fast answer');
    expect(deltas.map((d) => d.sequence)).toEqual([0, 1]);
    expect(s.requests[0].headers.authorization).toBe('Bearer test-key-123');
  });

  it('lists its pinned free-tier model', async () => {
    const provider = new CerebrasLlmProvider(key);
    const models = await provider.listModels(signal());
    expect(models).toHaveLength(1);
    expect(models[0].providerId).toBe('cerebras');
  });

  it('warmup opens an authenticated connection to /models', async () => {
    const s = await server((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [] }));
    });
    const provider = new CerebrasLlmProvider(key, s.baseUrl);
    await provider.warmup('llama3.1-8b', signal());
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0].url).toBe('/models');
    expect(s.requests[0].headers.authorization).toBe('Bearer test-key-123');
  });

  it('warmup is a no-op without a stored key', async () => {
    const s = await server((_req, res) => {
      res.end('{}');
    });
    const provider = new CerebrasLlmProvider(async () => null, s.baseUrl);
    await provider.warmup('llama3.1-8b', signal());
    expect(s.requests).toHaveLength(0);
  });

  it('reports CREDENTIAL_MISSING before any network call when generating without a key', async () => {
    const s = await server((_req, res) => {
      res.end('{}');
    });
    const provider = new CerebrasLlmProvider(async () => null, s.baseUrl);
    await expect(collect(provider.generate(request()))).rejects.toMatchObject({
      public: { code: 'CREDENTIAL_MISSING' },
    });
    expect(s.requests).toHaveLength(0);
  });
});
