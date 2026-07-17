import { afterEach, describe, expect, it } from 'vitest';
import { OllamaProvider } from '../../src/main/providers/llm/ollama';
import { GroqLlmProvider } from '../../src/main/providers/llm/groq';
import { GeminiLlmProvider } from '../../src/main/providers/llm/gemini';
import { OpenRouterProvider } from '../../src/main/providers/llm/openRouter';
import {
  GroqWhisperProvider,
  GROQ_MAX_UPLOAD_BYTES,
} from '../../src/main/providers/stt/groqWhisper';
import { GeminiAudioProvider } from '../../src/main/providers/stt/geminiAudio';
import { bodyChunks, type AnswerRequest } from '../../src/main/providers/contracts';
import { allowlistedFetch } from '../../src/main/security/http';
import { toPublicError } from '../../src/shared/errors';
import {
  collect,
  collectUntilError,
  startFakeServer,
  writeThenDestroy,
  type FakeServer,
} from '../helpers/fakeServer';
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

const sse = (deltas: string[]) =>
  deltas
    .map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`)
    .join('') + 'data: [DONE]\n\n';

const geminiFrame = (text: string) =>
  `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n\n`;

function transcribeInput(baseAudio = sineWav(1)) {
  return {
    audio: baseAudio,
    mimeType: 'audio/wav' as const,
    modelId: 'whisper-large-v3-turbo',
    signal: new AbortController().signal,
  };
}

describe('stage timeouts (allowlistedFetch)', () => {
  it('maps a response that outlives the stage timeout to PROVIDER_TIMEOUT', async () => {
    const s = await server(async (_req, res) => {
      res.on('error', () => undefined);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      try {
        res.end('too late');
      } catch {
        /* client is long gone */
      }
    });
    await expect(allowlistedFetch(`${s.baseUrl}/slow`, { timeoutMs: 250 })).rejects.toThrow(
      /PROVIDER_TIMEOUT/,
    );
  });

  it('a body that stalls past the timeout aborts mid-stream and maps to PROVIDER_TIMEOUT upstream', async () => {
    const s = await server((_req, res) => {
      res.on('error', () => undefined);
      res.setHeader('content-type', 'text/event-stream');
      res.write('data: early\n\n');
      // never send anything else, never end
    });
    // Generous timeout so headers reliably arrive under parallel test load;
    // the body still stalls forever, so only the mid-body abort can fire.
    const res = await allowlistedFetch(`${s.baseUrl}/stall`, { timeoutMs: 1_000 });
    const { items, error } = await collectUntilError(bodyChunks(res));
    expect(items.length).toBeGreaterThan(0); // the early chunk arrived
    // Providers rethrow this raw; the coordinator maps it via toPublicError.
    expect(toPublicError(error).code).toBe('PROVIDER_TIMEOUT');
  });
});

describe('host allowlist enforcement', () => {
  it('refuses a cloud LLM base URL that is not on the allowlist, before any socket opens', async () => {
    await expect(
      collect(
        new GroqLlmProvider(key, 'https://api.groq.com.evil.example/openai/v1').generate(request()),
      ),
    ).rejects.toThrow(/host not allowed/);
  });

  it('refuses a cloud STT base URL that is not on the allowlist', async () => {
    await expect(
      new GroqWhisperProvider(key, 'https://evil.example.com/openai/v1').transcribe(
        transcribeInput(),
      ),
    ).rejects.toThrow(/host not allowed/);
  });

  it('refuses plain-http Ollama base URLs that are not loopback', async () => {
    await expect(
      collect(new OllamaProvider(async () => 'http://10.0.0.7:11434').generate(request())),
    ).rejects.toThrow(/host not allowed/);
  });
});

describe('OllamaProvider failure modes', () => {
  it('maps 500 to PROVIDER_UNAVAILABLE', async () => {
    const s = await server((_req, res) => void res.writeHead(500).end('{}'));
    await expect(
      collect(new OllamaProvider(async () => s.baseUrl).generate(request())),
    ).rejects.toThrow(/PROVIDER_UNAVAILABLE/);
  });

  it('surfaces an in-band NDJSON error frame as PROVIDER_UNAVAILABLE after earlier deltas', async () => {
    const s = await server((_req, res) => {
      res.setHeader('content-type', 'application/x-ndjson');
      res.write(`${JSON.stringify({ message: { content: 'ok ' }, done: false })}\n`);
      res.end(`${JSON.stringify({ error: 'model runner crashed' })}\n`);
    });
    const { items, error } = await collectUntilError(
      new OllamaProvider(async () => s.baseUrl).generate(request()),
    );
    expect(items.map((d) => d.text)).toEqual(['ok ']);
    expect(String(error)).toMatch(/PROVIDER_UNAVAILABLE/);
    expect(String(error)).toMatch(/model runner crashed/);
  });

  it('rejects when the connection drops mid-stream instead of treating the truncation as EOF', async () => {
    const s = await server(async (_req, res) => {
      res.setHeader('content-type', 'application/x-ndjson');
      await writeThenDestroy(
        res,
        `${JSON.stringify({ message: { content: 'Hello ' }, done: false })}\n`,
      );
    });
    const { items, error } = await collectUntilError(
      new OllamaProvider(async () => s.baseUrl).generate(request()),
    );
    expect(items.map((d) => d.text)).toEqual(['Hello ']);
    expect(error).toBeTruthy();
  });

  it('fails fast on a malformed NDJSON line rather than emitting further deltas', async () => {
    const s = await server(async (_req, res) => {
      // Separate writes so the good line lands in its own chunk; a malformed
      // line sharing a chunk would also swallow the valid deltas before it.
      res.write(`${JSON.stringify({ message: { content: 'ok' }, done: false })}\n`);
      await new Promise((resolve) => setTimeout(resolve, 30));
      res.end('{this is not json}\n');
    });
    // NdjsonParser throws on garbage; the raw error surfaces as UNKNOWN upstream.
    const { items, error } = await collectUntilError(
      new OllamaProvider(async () => s.baseUrl).generate(request()),
    );
    expect(items.map((d) => d.text)).toEqual(['ok']);
    expect(error).toBeTruthy();
  });
});

describe('GroqLlmProvider failure modes', () => {
  it('does not honor an unreasonable Retry-After and fails fast as PROVIDER_RATE_LIMITED', async () => {
    const s = await server((_req, res) => void res.writeHead(429, { 'retry-after': '3600' }).end());
    const started = Date.now();
    await expect(collect(new GroqLlmProvider(key, s.baseUrl).generate(request()))).rejects.toThrow(
      /PROVIDER_RATE_LIMITED/,
    );
    expect(s.requests).toHaveLength(1); // no retry attempted
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('retries at most once when every attempt is rate limited', async () => {
    const s = await server((_req, res) => void res.writeHead(429, { 'retry-after': '1' }).end());
    await expect(collect(new GroqLlmProvider(key, s.baseUrl).generate(request()))).rejects.toThrow(
      /PROVIDER_RATE_LIMITED/,
    );
    expect(s.requests).toHaveLength(2);
  });

  it('aborting during the Retry-After wait cancels immediately without a second request', async () => {
    const controller = new AbortController();
    let sawRequest!: () => void;
    const gotRequest = new Promise<void>((resolve) => {
      sawRequest = resolve;
    });
    const s = await server((_req, res) => {
      res.writeHead(429, { 'retry-after': '2' }).end();
      sawRequest();
    });
    const pending = collect(
      new GroqLlmProvider(key, s.baseUrl).generate(request({ signal: controller.signal })),
    );
    await gotRequest; // abort only once the 429 has been served, mid Retry-After wait
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow(/abort/i);
    expect(s.requests).toHaveLength(1);
  });

  it('maps 503 to PROVIDER_UNAVAILABLE', async () => {
    const s = await server((_req, res) => void res.writeHead(503).end());
    await expect(collect(new GroqLlmProvider(key, s.baseUrl).generate(request()))).rejects.toThrow(
      /PROVIDER_UNAVAILABLE/,
    );
  });

  it('rejects when the connection drops mid-SSE-stream, keeping deltas seen so far', async () => {
    const s = await server(async (_req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      await writeThenDestroy(
        res,
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial ' } }] })}\n\n`,
      );
    });
    const { items, error } = await collectUntilError(
      new GroqLlmProvider(key, s.baseUrl).generate(request()),
    );
    expect(items.map((d) => d.text)).toEqual(['partial ']);
    expect(error).toBeTruthy();
  });

  it('a 200 non-SSE (e.g. captive-portal HTML) body yields zero deltas without throwing', async () => {
    // Documents current behavior: the adapter neither checks content-type nor
    // treats an empty stream as an error, so the coordinator would emit an
    // empty answer-complete. Recorded here so a future content-type check is a
    // deliberate change.
    const s = await server((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<html><body>Hotel Wi-Fi login</body></html>');
    });
    const deltas = await collect(new GroqLlmProvider(key, s.baseUrl).generate(request()));
    expect(deltas).toEqual([]);
  });

  // README ("Paid model IDs are rejected by design") promises rejection, but
  // GroqLlmProvider.generate (src/main/providers/llm/groq.ts:37-46) forwards any
  // model id straight to the API; only listModels pins the free-plan model.
  // Only the OpenRouter adapter enforces the free-model policy at generate time.
  it.fails('rejects a non-catalog (potentially paid) model id before contacting Groq', async () => {
    const s = await server((_req, res) => void res.end(sse([])));
    await expect(
      collect(
        new GroqLlmProvider(key, s.baseUrl).generate(
          request({ modelId: 'llama-3.3-70b-versatile' }),
        ),
      ),
    ).rejects.toThrow();
  });
});

describe('GeminiLlmProvider failure modes', () => {
  it('throws CREDENTIAL_MISSING without a key and never contacts the server', async () => {
    const s = await server((_req, res) => void res.end());
    await expect(
      collect(new GeminiLlmProvider(async () => null, s.baseUrl).generate(request())),
    ).rejects.toThrow(/CREDENTIAL_MISSING/);
    expect(s.requests).toHaveLength(0);
  });

  it('maps 429 to PROVIDER_RATE_LIMITED in a single attempt (no retry loop on this path)', async () => {
    const s = await server((_req, res) => void res.writeHead(429).end('{}'));
    await expect(
      collect(new GeminiLlmProvider(key, s.baseUrl).generate(request())),
    ).rejects.toThrow(/PROVIDER_RATE_LIMITED/);
    expect(s.requests).toHaveLength(1);
  });

  it('maps 500 to PROVIDER_UNAVAILABLE', async () => {
    const s = await server((_req, res) => void res.writeHead(500).end('{}'));
    await expect(
      collect(new GeminiLlmProvider(key, s.baseUrl).generate(request())),
    ).rejects.toThrow(/PROVIDER_UNAVAILABLE/);
  });

  it('tolerates malformed and schema-violating SSE frames', async () => {
    const s = await server((_req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      res.end(
        'data: {not json\n\n' +
          `data: ${JSON.stringify({ candidates: 'wrong shape' })}\n\n` +
          geminiFrame('survived'),
      );
    });
    const deltas = await collect(new GeminiLlmProvider(key, s.baseUrl).generate(request()));
    expect(deltas.map((d) => d.text)).toEqual(['survived']);
  });

  it('rejects when the connection drops mid-stream, keeping deltas seen so far', async () => {
    const s = await server(async (_req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      await writeThenDestroy(res, geminiFrame('Part one '));
    });
    const { items, error } = await collectUntilError(
      new GeminiLlmProvider(key, s.baseUrl).generate(request()),
    );
    expect(items.map((d) => d.text)).toEqual(['Part one ']);
    expect(error).toBeTruthy();
  });

  // Gemini signals an invalid API key with HTTP 400 (API_KEY_INVALID). probe()
  // knows this and reports missing-credential for 400 (gemini.ts:43-49), but
  // generate() routes 400 through mapHttpStatus, which returns
  // PROVIDER_UNAVAILABLE (openAiCompatible.ts:20-34) — so a bad key mid-session
  // shows "provider unavailable / switch provider" instead of "replace key".
  // GeminiAudioProvider.transcribe has the same divergence.
  it.fails('maps 400 (Gemini API_KEY_INVALID) to CREDENTIAL_REJECTED like probe does', async () => {
    const s = await server(
      (_req, res) =>
        void res
          .writeHead(400)
          .end(
            JSON.stringify({ error: { status: 'INVALID_ARGUMENT', message: 'API key not valid' } }),
          ),
    );
    await expect(
      collect(new GeminiLlmProvider(key, s.baseUrl).generate(request())),
    ).rejects.toThrow(/CREDENTIAL_REJECTED/);
  });

  // Same README promise as the Groq case: nothing stops a (corrupted or
  // renderer-supplied) settings value like gemini-2.5-pro from being sent.
  it.fails(
    'rejects a non-catalog (potentially paid) model id before contacting Gemini',
    async () => {
      const s = await server((_req, res) => void res.end(geminiFrame('paid answer')));
      await expect(
        collect(
          new GeminiLlmProvider(key, s.baseUrl).generate(request({ modelId: 'gemini-2.5-pro' })),
        ),
      ).rejects.toThrow();
    },
  );
});

describe('GroqWhisperProvider failure modes', () => {
  it('throws CREDENTIAL_MISSING without a key and never contacts the server', async () => {
    const s = await server((_req, res) => void res.end());
    await expect(
      new GroqWhisperProvider(async () => null, s.baseUrl).transcribe(transcribeInput()),
    ).rejects.toThrow(/CREDENTIAL_MISSING/);
    expect(s.requests).toHaveLength(0);
  });

  it('maps 429 to PROVIDER_RATE_LIMITED (STT path has no Retry-After retry)', async () => {
    const s = await server((_req, res) => void res.writeHead(429, { 'retry-after': '1' }).end());
    await expect(
      new GroqWhisperProvider(key, s.baseUrl).transcribe(transcribeInput()),
    ).rejects.toThrow(/PROVIDER_RATE_LIMITED/);
    expect(s.requests).toHaveLength(1);
  });

  it('maps 500 to PROVIDER_UNAVAILABLE', async () => {
    const s = await server((_req, res) => void res.writeHead(500).end());
    await expect(
      new GroqWhisperProvider(key, s.baseUrl).transcribe(transcribeInput()),
    ).rejects.toThrow(/PROVIDER_UNAVAILABLE/);
  });

  it('normalizes a whitespace-only transcription to empty text for the TRANSCRIPT_EMPTY gate', async () => {
    const s = await server((_req, res) => void res.end(JSON.stringify({ text: '   \n ' })));
    const result = await new GroqWhisperProvider(key, s.baseUrl).transcribe(transcribeInput());
    expect(result.text).toBe('');
  });

  it('rejects a 200 response whose body is not JSON (wrong content-type / proxy page)', async () => {
    const s = await server((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<html>Bad gateway</html>');
    });
    await expect(
      new GroqWhisperProvider(key, s.baseUrl).transcribe(transcribeInput()),
    ).rejects.toThrow();
  });

  it('rejects clips over the upload cap with AUDIO_TOO_LONG before contacting the server', async () => {
    const s = await server((_req, res) => void res.end());
    await expect(
      new GroqWhisperProvider(key, s.baseUrl).transcribe(
        transcribeInput(new Uint8Array(GROQ_MAX_UPLOAD_BYTES + 1)),
      ),
    ).rejects.toThrow(/AUDIO_TOO_LONG/);
    expect(s.requests).toHaveLength(0);
  });
});

describe('GeminiAudioProvider failure modes', () => {
  const input = () => ({
    audio: sineWav(1),
    mimeType: 'audio/wav' as const,
    modelId: 'gemini-2.5-flash',
    signal: new AbortController().signal,
  });

  it('throws CREDENTIAL_MISSING without a key and never contacts the server', async () => {
    const s = await server((_req, res) => void res.end());
    await expect(
      new GeminiAudioProvider(async () => null, s.baseUrl).transcribe(input()),
    ).rejects.toThrow(/CREDENTIAL_MISSING/);
    expect(s.requests).toHaveLength(0);
  });

  it('maps 429 to PROVIDER_RATE_LIMITED and 503 to PROVIDER_UNAVAILABLE', async () => {
    const s = await server((_req, res) => void res.writeHead(429).end('{}'));
    const provider = new GeminiAudioProvider(key, s.baseUrl);
    await expect(provider.transcribe(input())).rejects.toThrow(/PROVIDER_RATE_LIMITED/);

    s.setHandler((_req, res) => void res.writeHead(503).end('{}'));
    await expect(provider.transcribe(input())).rejects.toThrow(/PROVIDER_UNAVAILABLE/);
  });

  it('returns empty text when Gemini responds with no candidates (e.g. safety-blocked)', async () => {
    const s = await server(
      (_req, res) =>
        void res.end(JSON.stringify({ candidates: [], promptFeedback: { blockReason: 'OTHER' } })),
    );
    const result = await new GeminiAudioProvider(key, s.baseUrl).transcribe(input());
    expect(result.text).toBe('');
  });
});

describe('OpenRouterProvider failure modes', () => {
  const modelsBody = JSON.stringify({
    data: [
      { id: 'meta/llama:free', name: 'Llama free', pricing: { prompt: '0', completion: '0' } },
    ],
  });

  it('falls back to cached models when a refresh fails (spec 12.5)', async () => {
    const s = await server((_req, res) => void res.end(modelsBody));
    const provider = new OpenRouterProvider(key, s.baseUrl);
    const first = await provider.listModels(new AbortController().signal);
    expect(first.map((m) => m.id)).toEqual(['openrouter/free', 'meta/llama:free']);

    s.setHandler((_req, res) => void res.writeHead(500).end());
    const second = await provider.listModels(new AbortController().signal);
    expect(second).toEqual(first);
  });

  it('propagates PROVIDER_UNAVAILABLE from listModels when there is no cache to fall back to', async () => {
    const s = await server((_req, res) => void res.writeHead(500).end());
    await expect(
      new OpenRouterProvider(key, s.baseUrl).listModels(new AbortController().signal),
    ).rejects.toThrow(/PROVIDER_UNAVAILABLE/);
  });

  it('maps 401 during generation to CREDENTIAL_REJECTED on the free router', async () => {
    const s = await server((_req, res) => void res.writeHead(401).end('{}'));
    await expect(
      collect(
        new OpenRouterProvider(key, s.baseUrl).generate(request({ modelId: 'openrouter/free' })),
      ),
    ).rejects.toThrow(/CREDENTIAL_REJECTED/);
  });
});
