import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../../src/main/providers/registry';
import type {
  AnswerRequest,
  LlmProvider,
  SttProvider,
  TranscribeInput,
} from '../../src/main/providers/contracts';
import { SessionCoordinator, type CoordinatorDeps } from '../../src/main/sessions/coordinator';
import { PROVIDERS } from '../../src/shared/catalog';
import type { AnswerDelta, SessionEvent, TranscriptResult } from '../../src/shared/domain';
import { CoachError } from '../../src/shared/errors';
import { sineWav, silentWav } from '../helpers/wav';

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SID2 = '11111111-2222-3333-4444-555555555555';
const OPTIONS = { answerMode: 'natural' as const, targetSeconds: 30 as const };

interface Harness {
  coordinator: SessionCoordinator;
  events: SessionEvent[];
  history: unknown[];
}

function makeHarness(overrides: {
  transcribe?: (input: TranscribeInput) => Promise<TranscriptResult>;
  generate?: (input: AnswerRequest) => AsyncIterable<AnswerDelta>;
  warmup?: (modelId: string, signal: AbortSignal) => Promise<void>;
  historyEnabled?: boolean;
}): Harness {
  const registry = new ProviderRegistry();
  const stt: SttProvider = {
    meta: { ...PROVIDERS['local-whisper'] },
    probe: async () => ({ providerId: 'local-whisper', status: 'ready' }),
    listModels: async () => [],
    transcribe:
      overrides.transcribe ?? (async () => ({ text: 'Tell me about a production incident.' })),
  };
  async function* defaultGenerate(): AsyncIterable<AnswerDelta> {
    yield { text: 'I would start ', sequence: 0 };
    yield { text: 'with the incident.', sequence: 1 };
  }
  const llm: LlmProvider = {
    meta: { ...PROVIDERS.ollama },
    probe: async () => ({ providerId: 'ollama', status: 'ready' }),
    listModels: async () => [],
    generate: overrides.generate ?? defaultGenerate,
    warmup: overrides.warmup,
  };
  registry.registerStt(stt);
  registry.registerLlm(llm);
  const events: SessionEvent[] = [];
  const history: unknown[] = [];
  const deps: CoordinatorDeps = {
    registry,
    getSettings: async () => ({
      sttProviderId: 'local-whisper',
      sttModelId: 'test-model',
      sttLanguage: 'auto',
      llmProviderId: 'ollama',
      llmModelId: 'test-llm',
      historyEnabled: overrides.historyEnabled ?? false,
      historyRetentionDays: 7,
      maxClipSeconds: 90,
      activeProfileId: undefined,
    }),
    getProfile: async () => null,
    saveHistory: async (item) => {
      history.push(item);
    },
    emit: (event) => events.push(event),
    recordError: () => undefined,
  };
  return { coordinator: new SessionCoordinator(deps), events, history };
}

describe('session pipeline', () => {
  it('runs WAV -> transcript -> ordered deltas -> complete', async () => {
    const { coordinator, events } = makeHarness({});
    await coordinator.submit(SID, sineWav(2), OPTIONS, 5);
    const types = events.map((e) => e.type);
    expect(types).toContain('transcript');
    expect(types[types.length - 1]).toBe('answer-complete');
    const deltas = events.filter((e) => e.type === 'answer-delta');
    expect(deltas.map((d) => (d.type === 'answer-delta' ? d.sequence : -1))).toEqual([0, 1]);
    const complete = events.find((e) => e.type === 'answer-complete');
    expect(complete?.type === 'answer-complete' && complete.text).toBe(
      'I would start with the incident.',
    );
    expect(events.every((e) => e.sessionId === SID)).toBe(true);
  });

  it('rejects silent clips before any provider call (CAP-10)', async () => {
    let sttCalled = false;
    const { coordinator, events } = makeHarness({
      transcribe: async () => {
        sttCalled = true;
        return { text: 'x' };
      },
    });
    await coordinator.submit(SID, silentWav(2), OPTIONS, 5);
    expect(sttCalled).toBe(false);
    const error = events.find((e) => e.type === 'error');
    expect(error?.type === 'error' && error.error.code).toBe('CAPTURE_SILENT');
  });

  it('rejects clips that are too short', async () => {
    const { coordinator, events } = makeHarness({});
    await coordinator.submit(SID, sineWav(0.2), OPTIONS, 5);
    const error = events.find((e) => e.type === 'error');
    expect(error?.type === 'error' && error.error.code).toBe('AUDIO_TOO_SHORT');
  });

  it('maps an empty transcript to TRANSCRIPT_EMPTY without calling the LLM', async () => {
    let llmCalled = false;
    async function* gen(): AsyncIterable<AnswerDelta> {
      llmCalled = true;
      yield { text: 'x', sequence: 0 };
    }
    const { coordinator, events } = makeHarness({
      transcribe: async () => ({ text: '   ' }),
      generate: gen,
    });
    await coordinator.submit(SID, sineWav(2), OPTIONS, 5);
    expect(llmCalled).toBe(false);
    const error = events.find((e) => e.type === 'error');
    expect(error?.type === 'error' && error.error.code).toBe('TRANSCRIPT_EMPTY');
  });

  it('propagates provider errors as structured public errors', async () => {
    const { coordinator, events } = makeHarness({
      transcribe: async () => {
        throw new CoachError('PROVIDER_RATE_LIMITED');
      },
    });
    await coordinator.submit(SID, sineWav(2), OPTIONS, 5);
    const error = events.find((e) => e.type === 'error');
    expect(error?.type === 'error' && error.error.code).toBe('PROVIDER_RATE_LIMITED');
    expect(error?.type === 'error' && error.error.retryable).toBe(true);
  });

  it('a new session aborts the old one and suppresses its late deltas', async () => {
    let firstStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let call = 0;
    async function* slowThenFast(input: AnswerRequest): AsyncIterable<AnswerDelta> {
      call += 1;
      if (call === 1) {
        firstStarted();
        yield { text: 'first-a', sequence: 0 };
        // Wait until aborted, then try to emit a late delta.
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (input.signal.aborted) return;
        yield { text: 'first-late', sequence: 1 };
      } else {
        yield { text: 'second', sequence: 0 };
      }
    }
    const { coordinator, events } = makeHarness({ generate: slowThenFast });
    const first = coordinator.submit(SID, sineWav(2), OPTIONS, 5);
    await gate;
    const second = coordinator.regenerate(SID2, 'edited transcript', OPTIONS);
    await Promise.all([first, second]);
    const texts = events
      .filter((e) => e.type === 'answer-delta')
      .map((e) => (e.type === 'answer-delta' ? `${e.sessionId}:${e.text}` : ''));
    expect(texts).toContain(`${SID2}:second`);
    expect(texts.some((t) => t.includes('first-late'))).toBe(false);
    // The retired session never completes.
    const completes = events.filter((e) => e.type === 'answer-complete');
    expect(completes).toHaveLength(1);
    expect(completes[0].sessionId).toBe(SID2);
  });

  it('cancel aborts the stream and emits no error to the renderer', async () => {
    let sawAbort = false;
    async function* endless(input: AnswerRequest): AsyncIterable<AnswerDelta> {
      yield { text: 'a', sequence: 0 };
      for (let i = 1; i < 100; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (input.signal.aborted) {
          sawAbort = true;
          throw new DOMException('aborted', 'AbortError');
        }
        yield { text: 'b', sequence: i };
      }
    }
    const { coordinator, events } = makeHarness({ generate: endless });
    const run = coordinator.submit(SID, sineWav(2), OPTIONS, 5);
    await new Promise((resolve) => setTimeout(resolve, 60));
    coordinator.cancel(SID);
    await run;
    expect(sawAbort).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.some((e) => e.type === 'answer-complete')).toBe(false);
  });

  it('regenerate skips transcription and streams from the given transcript', async () => {
    let sttCalled = false;
    const { coordinator, events } = makeHarness({
      transcribe: async () => {
        sttCalled = true;
        return { text: 'never' };
      },
    });
    await coordinator.regenerate(SID, 'my edited question', OPTIONS);
    expect(sttCalled).toBe(false);
    expect(events.some((e) => e.type === 'answer-complete')).toBe(true);
  });

  it('warms the LLM while transcription is still running', async () => {
    let warmedModel: string | null = null;
    let warmDuringTranscription = false;
    const { coordinator } = makeHarness({
      warmup: async (modelId) => {
        warmedModel = modelId;
      },
      transcribe: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        warmDuringTranscription = warmedModel !== null;
        return { text: 'Tell me about a production incident.' };
      },
    });
    await coordinator.submit(SID, sineWav(2), OPTIONS, 5);
    expect(warmedModel).toBe('test-llm');
    expect(warmDuringTranscription).toBe(true);
  });

  it('completes the session normally when warmup fails', async () => {
    const { coordinator, events } = makeHarness({
      warmup: async () => {
        throw new Error('provider is cold and unhappy');
      },
    });
    await coordinator.submit(SID, sineWav(2), OPTIONS, 5);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.some((e) => e.type === 'answer-complete')).toBe(true);
  });

  it('aborts the warmup signal when the session is cancelled', async () => {
    let warmupSignal: AbortSignal | null = null;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { coordinator } = makeHarness({
      warmup: async (_modelId, signal) => {
        warmupSignal = signal;
      },
      transcribe: async () => {
        await gate;
        return { text: 'never delivered' };
      },
    });
    const run = coordinator.submit(SID, sineWav(2), OPTIONS, 5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    coordinator.cancel(SID);
    release();
    await run;
    expect(warmupSignal).not.toBeNull();
    expect(warmupSignal!.aborted).toBe(true);
  });

  it('prewarm loads the configured LLM model outside any session', async () => {
    let warmedModel: string | null = null;
    const { coordinator, events } = makeHarness({
      warmup: async (modelId) => {
        warmedModel = modelId;
      },
    });
    await coordinator.prewarm();
    expect(warmedModel).toBe('test-llm');
    // No session exists, so prewarm must emit nothing to the renderer.
    expect(events).toHaveLength(0);
  });

  it('prewarm swallows warmup failures silently', async () => {
    const { coordinator, events } = makeHarness({
      warmup: async () => {
        throw new Error('model is cold and the disk is slow');
      },
    });
    await expect(coordinator.prewarm()).resolves.toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it('prewarm is a no-op for providers without warmup support', async () => {
    const { coordinator, events } = makeHarness({});
    await expect(coordinator.prewarm()).resolves.toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it('saves history only when enabled', async () => {
    const off = makeHarness({ historyEnabled: false });
    await off.coordinator.submit(SID, sineWav(2), OPTIONS, 5);
    expect(off.history).toHaveLength(0);

    const on = makeHarness({ historyEnabled: true });
    await on.coordinator.submit(SID, sineWav(2), OPTIONS, 5);
    expect(on.history).toHaveLength(1);
  });
});
