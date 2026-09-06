import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GroqLlmProvider } from '../../src/main/providers/llm/groq';
import { GroqWhisperProvider } from '../../src/main/providers/stt/groqWhisper';
import { CLOUD_MODELS } from '../../src/shared/catalog';
import type { AnswerIntent } from '../../src/shared/domain';
import { answerTemperature, answerTokenBudget, buildPrompt } from '../../src/shared/prompt';

// Explicitly opt in to remote calls; neither normal test tier includes this directory.
// The application still uses its encrypted vault, never environment credentials.
const apiKey = process.env.GROQ_API_KEY?.trim();
const audioPath = process.env.CUEDECK_GROQ_AUDIO;
const key = async () => apiKey ?? null;

const syntheticContext = {
  profile: {
    summary: 'Backend developer working with C# and ASP.NET Core APIs.',
    roleContext: 'Practicing for a backend engineering interview.',
    emphasisNotes: 'Prefer practical explanations of request handling and concurrency.',
  },
  systemPrompt: 'Use plain English and C# or ASP.NET Core terminology and examples.',
  transcript: 'How does async/await help an ASP.NET Core API handle slow external HTTP requests?',
  answerMode: 'concise' as const,
  targetSeconds: 15 as const,
};

function wordCount(text: string): number {
  return text.trim().split(/\s+/).length;
}

async function generate(modelId: string, answerIntent: AnswerIntent, referenceAnswer?: string) {
  const prompt = buildPrompt({ ...syntheticContext, answerIntent, referenceAnswer });
  let text = '';
  let chunks = 0;
  const started = Date.now();
  let firstTokenMs: number | undefined;
  for await (const delta of new GroqLlmProvider(key).generate({
    ...prompt,
    modelId,
    temperature: answerTemperature(syntheticContext.answerMode),
    maxTokens: answerTokenBudget(syntheticContext.targetSeconds, answerIntent),
    signal: AbortSignal.timeout(45_000),
  })) {
    firstTokenMs ??= Date.now() - started;
    expect(delta.sequence).toBe(chunks++);
    text += delta.text;
  }
  expect(text.trim().length).toBeGreaterThan(20);
  expect(text).not.toMatch(/<think>|<\/think>/i);
  expect(text).toMatch(/async|await|task|thread/i);
  // Report timing and size only. Never log credentials, request bodies, or user audio.
  process.stdout.write(
    `${modelId} ${answerIntent}: ${wordCount(text)} words, ${chunks} deltas, first token ${firstTokenMs} ms\n`,
  );
  return text;
}

describe.skipIf(!apiKey)('Groq live API (requires GROQ_API_KEY)', () => {
  it('authenticates the response and speech adapters with the same key', async () => {
    for (const provider of [new GroqLlmProvider(key), new GroqWhisperProvider(key)]) {
      const probe = await provider.probe(AbortSignal.timeout(20_000));
      expect(probe.status).toBe('ready');
    }
  }, 45_000);

  it.each([CLOUD_MODELS.groqLlmModel, CLOUD_MODELS.groqLlmFastModel])(
    '%s streams a concise personalized answer and a fuller worked example',
    async (modelId) => {
      const initial = await generate(modelId, 'initial');
      expect(wordCount(initial)).toBeLessThanOrEqual(100);
      const example = await generate(modelId, 'example', initial);
      expect(wordCount(example)).toBeGreaterThan(wordCount(initial));
      expect(example).toMatch(/C#|C sharp|ASP\.NET|HttpClient|Task</i);
    },
    100_000,
  );

  it.skipIf(!audioPath)(
    'transcribes the optional WAV or FLAC fixture with Groq Whisper',
    async () => {
      const extension = path.extname(audioPath!).toLowerCase();
      expect(['.wav', '.flac']).toContain(extension);
      const audio = await readFile(audioPath!);
      const transcript = await new GroqWhisperProvider(key).transcribe({
        audio,
        mimeType: extension === '.flac' ? 'audio/flac' : 'audio/wav',
        modelId: CLOUD_MODELS.groqSttModel,
        signal: AbortSignal.timeout(45_000),
      });
      expect(transcript.text.trim().length).toBeGreaterThan(0);
      process.stdout.write(`Groq Whisper: ${wordCount(transcript.text)} words transcribed\n`);
    },
    50_000,
  );
});
