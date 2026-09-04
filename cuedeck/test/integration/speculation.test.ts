import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../../src/main/providers/registry';
import type {
  AnswerRequest,
  LlmProvider,
  SttProvider,
  TranscribeInput,
  WarmupPrefix,
} from '../../src/main/providers/contracts';
import { SessionCoordinator, type CoordinatorDeps } from '../../src/main/sessions/coordinator';
import { encodeWav } from '../../src/shared/audio';
import { PROVIDERS } from '../../src/shared/catalog';
import { MAX_CLOUD_SPECULATIONS_PER_CLIP } from '../../src/shared/constants';
import type { AnswerDelta, Profile, SessionEvent } from '../../src/shared/domain';
import { buildPrompt } from '../../src/shared/prompt';

/**
 * Speculative transcription: the renderer sends a snapshot of the clip at
 * silence onset; when the final clip turns out to be that snapshot plus
 * silence, the coordinator reuses the transcript and never calls the STT
 * provider a second time.
 */

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SID2 = '11111111-2222-3333-4444-555555555555';
const OPTIONS = { answerMode: 'natural' as const, targetSeconds: 30 as const };
const RATE = 16_000;

function tone(seconds: number, amplitude = 0.3): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / RATE);
  }
  return out;
}

function silence(seconds: number): Float32Array {
  return new Float32Array(Math.round(seconds * RATE));
}

function wavOf(...parts: Float32Array[]): Uint8Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return encodeWav(out, RATE);
}

const QUESTION = tone(3);
const SNAPSHOT = wavOf(QUESTION, silence(0.7));
const FINAL_SAME = wavOf(QUESTION, silence(1.6));
const FINAL_MORE_SPEECH = wavOf(QUESTION, silence(0.7), tone(1.5), silence(1.6));

interface Harness {
  coordinator: SessionCoordinator;
  events: SessionEvent[];
  sttCalls: TranscribeInput[];
  sttSignals: AbortSignal[];
  llmRequests: AnswerRequest[];
  warmups: Array<{ modelId: string; prefix?: WarmupPrefix }>;
}

function makeHarness(
  overrides: {
    location?: 'local' | 'cloud';
    transcribe?: (input: TranscribeInput, call: number) => Promise<string>;
    profile?: Profile | null;
  } = {},
): Harness {
  const registry = new ProviderRegistry();
  const sttCalls: TranscribeInput[] = [];
  const sttSignals: AbortSignal[] = [];
  const stt: SttProvider = {
    meta: { ...PROVIDERS['local-whisper'], location: overrides.location ?? 'local' },
    probe: async () => ({ providerId: 'local-whisper', status: 'ready' }),
    listModels: async () => [],
    transcribe: async (input) => {
      sttCalls.push(input);
      sttSignals.push(input.signal);
      const text = overrides.transcribe
        ? await overrides.transcribe(input, sttCalls.length)
        : `transcript #${sttCalls.length}`;
      return { text };
    },
  };
  const llmRequests: AnswerRequest[] = [];
  const warmups: Array<{ modelId: string; prefix?: WarmupPrefix }> = [];
  async function* generate(input: AnswerRequest): AsyncIterable<AnswerDelta> {
    llmRequests.push(input);
    yield { text: 'Answer.', sequence: 0 };
  }
  const llm: LlmProvider = {
    meta: { ...PROVIDERS.ollama },
    probe: async () => ({ providerId: 'ollama', status: 'ready' }),
    listModels: async () => [],
    generate,
    warmup: async (modelId, _signal, prefix) => {
      warmups.push({ modelId, prefix });
    },
  };
  registry.registerStt(stt);
  registry.registerLlm(llm);
  const events: SessionEvent[] = [];
  const deps: CoordinatorDeps = {
    registry,
    getSettings: async () => ({
      sttProviderId: 'local-whisper',
      sttModelId: 'test-model',
      sttLanguage: 'auto',
      llmProviderId: 'ollama',
      llmModelId: 'test-llm',
      historyEnabled: false,
      historyRetentionDays: 7,
      maxClipSeconds: 90,
      activeProfileId: overrides.profile ? overrides.profile.id : undefined,
      answerMode: 'natural',
      targetSeconds: 30,
    }),
    getProfile: async () => overrides.profile ?? null,
    saveHistory: async () => undefined,
    emit: (event) => events.push(event),
    recordError: () => undefined,
  };
  return {
    coordinator: new SessionCoordinator(deps),
    events,
    sttCalls,
    sttSignals,
    llmRequests,
    warmups,
  };
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function completed(events: SessionEvent[]) {
  return events.find((e) => e.type === 'answer-complete');
}

describe('speculative transcription', () => {
  it('reuses the speculative transcript when the final clip only adds silence', async () => {
    const h = makeHarness({});
    await h.coordinator.speculate(SID, SNAPSHOT, 'auto');
    await h.coordinator.submit(SID, FINAL_SAME, OPTIONS, 5);
    expect(h.sttCalls).toHaveLength(1);
    const done = completed(h.events);
    expect(done?.type === 'answer-complete' && done.metrics.sttSpeculative).toBe(true);
    const transcript = h.events.find((e) => e.type === 'transcript');
    expect(transcript?.type === 'transcript' && transcript.text).toBe('transcript #1');
  });

  it('waits for a still-running speculation instead of starting over', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = makeHarness({
      transcribe: async (_input, call) => {
        if (call === 1) await gate;
        return `transcript #${call}`;
      },
    });
    await h.coordinator.speculate(SID, SNAPSHOT);
    const run = h.coordinator.submit(SID, FINAL_SAME, OPTIONS, 5);
    await tick(20);
    expect(h.sttCalls).toHaveLength(1);
    expect(completed(h.events)).toBeUndefined();
    release();
    await run;
    expect(h.sttCalls).toHaveLength(1);
    expect(completed(h.events)).toBeDefined();
  });

  it('runs a fresh pass when speech follows the snapshot', async () => {
    const h = makeHarness({});
    await h.coordinator.speculate(SID, SNAPSHOT);
    await h.coordinator.submit(SID, FINAL_MORE_SPEECH, OPTIONS, 5);
    expect(h.sttCalls).toHaveLength(2);
    const transcript = h.events.find((e) => e.type === 'transcript');
    expect(transcript?.type === 'transcript' && transcript.text).toBe('transcript #2');
    const done = completed(h.events);
    expect(done?.type === 'answer-complete' && done.metrics.sttSpeculative).toBeFalsy();
  });

  it('ignores a speculation that belongs to another session', async () => {
    const h = makeHarness({});
    await h.coordinator.speculate(SID2, SNAPSHOT);
    await h.coordinator.submit(SID, FINAL_SAME, OPTIONS, 5);
    expect(h.sttCalls).toHaveLength(2);
  });

  it('falls back to a fresh pass when the speculation failed', async () => {
    const h = makeHarness({
      transcribe: async (_input, call) => {
        if (call === 1) throw new Error('worker crashed');
        return 'recovered';
      },
    });
    await h.coordinator.speculate(SID, SNAPSHOT);
    await tick();
    await h.coordinator.submit(SID, FINAL_SAME, OPTIONS, 5);
    expect(h.sttCalls).toHaveLength(2);
    expect(h.events.some((e) => e.type === 'error')).toBe(false);
    const transcript = h.events.find((e) => e.type === 'transcript');
    expect(transcript?.type === 'transcript' && transcript.text).toBe('recovered');
  });

  it('never emits renderer events on its own', async () => {
    const h = makeHarness({});
    await h.coordinator.speculate(SID, SNAPSHOT);
    await tick();
    expect(h.events).toHaveLength(0);
  });

  it('drops snapshots shorter than the minimum clip', async () => {
    const h = makeHarness({});
    await h.coordinator.speculate(SID, wavOf(tone(0.2)));
    await tick();
    expect(h.sttCalls).toHaveLength(0);
  });

  it('cancel aborts the speculative request for that session', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = makeHarness({
      transcribe: async (input) => {
        await Promise.race([
          gate,
          new Promise((_, reject) =>
            input.signal.addEventListener('abort', () => reject(new Error('aborted'))),
          ),
        ]);
        return 'x';
      },
    });
    await h.coordinator.speculate(SID, SNAPSHOT);
    await tick();
    h.coordinator.cancel(SID);
    expect(h.sttSignals[0].aborted).toBe(true);
    release();
    expect(h.events).toHaveLength(0);
  });

  describe('superseding snapshots', () => {
    it('local: a newer snapshot waits for the running one, then runs; the stale one is left alone', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const h = makeHarness({
        location: 'local',
        transcribe: async (_input, call) => {
          if (call === 1) await gate;
          return `transcript #${call}`;
        },
      });
      await h.coordinator.speculate(SID, SNAPSHOT);
      await h.coordinator.speculate(SID, wavOf(QUESTION, silence(0.7), tone(1.5), silence(0.7)));
      await tick();
      expect(h.sttCalls).toHaveLength(1);
      expect(h.sttSignals[0].aborted).toBe(false);
      release();
      await tick(20);
      expect(h.sttCalls).toHaveLength(2);
      // The final clip extends the *second* snapshot with silence: reused.
      await h.coordinator.submit(SID, FINAL_MORE_SPEECH, OPTIONS, 5);
      expect(h.sttCalls).toHaveLength(2);
      const transcript = h.events.find((e) => e.type === 'transcript');
      expect(transcript?.type === 'transcript' && transcript.text).toBe('transcript #2');
    });

    it('cloud: a newer snapshot aborts the running request so no quota is wasted', async () => {
      const h = makeHarness({
        location: 'cloud',
        transcribe: async (input, call) => {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 50);
            input.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            });
          });
          return `transcript #${call}`;
        },
      });
      await h.coordinator.speculate(SID, SNAPSHOT);
      await h.coordinator.speculate(SID, wavOf(QUESTION, silence(0.7), tone(1.5), silence(0.7)));
      expect(h.sttCalls).toHaveLength(2);
      expect(h.sttSignals[0].aborted).toBe(true);
      expect(h.sttSignals[1].aborted).toBe(false);
    });

    it('a local speculation is not aborted when the final clip does not match', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const h = makeHarness({
        location: 'local',
        transcribe: async (_input, call) => {
          if (call === 1) await gate;
          return `transcript #${call}`;
        },
      });
      await h.coordinator.speculate(SID, SNAPSHOT);
      const run = h.coordinator.submit(SID, FINAL_MORE_SPEECH, OPTIONS, 5);
      await tick();
      expect(h.sttSignals[0].aborted).toBe(false);
      release();
      await run;
      expect(completed(h.events)).toBeDefined();
    });
  });
});

describe('prepared audio', () => {
  it('hands local providers decoded samples with leading and trailing silence trimmed', async () => {
    const h = makeHarness({});
    await h.coordinator.submit(SID, wavOf(silence(3), QUESTION, silence(2)), OPTIONS, 5);
    const input = h.sttCalls[0];
    expect(input.samples).toBeDefined();
    // 3 s speech + 250 ms padding each side, give or take a window.
    expect(input.samples!.length).toBeLessThan(RATE * 3.7);
    expect(input.samples!.length).toBeGreaterThan(RATE * 3.3);
    // The WAV bytes describe the same trimmed audio.
    expect(input.audio.byteLength).toBe(44 + input.samples!.length * 2);
  });

  it('passes the original bytes through when there is nothing to trim', async () => {
    const h = makeHarness({});
    const wav = wavOf(QUESTION);
    await h.coordinator.submit(SID, wav, OPTIONS, 5);
    expect(h.sttCalls[0].audio).toBe(wav);
  });
});

describe('LLM warmup prefix', () => {
  const PROFILE: Profile = {
    id: 'p1',
    name: 'Prep',
    summary: 'Support engineer, 4 years.',
    roleContext: 'Screening call.',
    emphasisNotes: '',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };

  it('prewarm sends the system prompt and profile blocks as the prefix', async () => {
    const h = makeHarness({ profile: PROFILE });
    await h.coordinator.prewarm();
    expect(h.warmups).toHaveLength(1);
    const prefix = h.warmups[0].prefix;
    expect(prefix).toBeDefined();
    expect(prefix!.user).toContain('<profile_data>');
    expect(prefix!.user).toContain('Support engineer');
  });

  it('the submit-time warmup prefix is a prefix of the real request', async () => {
    const h = makeHarness({ profile: PROFILE });
    await h.coordinator.submit(
      SID,
      wavOf(QUESTION),
      { ...OPTIONS, answerMode: 'technical', sessionNotes: 'Acme' },
      5,
    );
    expect(h.warmups).toHaveLength(1);
    const prefix = h.warmups[0].prefix!;
    const real = h.llmRequests[0];
    expect(real.system).toBe(prefix.system);
    expect(real.user.startsWith(prefix.user)).toBe(true);
    expect(real.user).toContain('<session_notes>');
    expect(prefix.user).not.toContain('<session_notes>');
    const expected = buildPrompt({
      profile: PROFILE,
      sessionNotes: 'Acme',
      transcript: 'transcript #1',
      answerMode: 'technical',
      targetSeconds: 30,
    });
    expect(real.user).toBe(expected.user);
  });

  it('coalesces identical warmups that are still in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = new ProviderRegistry();
    let calls = 0;
    registry.registerStt({
      meta: { ...PROVIDERS['local-whisper'] },
      probe: async () => ({ providerId: 'local-whisper', status: 'ready' }),
      listModels: async () => [],
      transcribe: async () => ({ text: 'q' }),
    });
    registry.registerLlm({
      meta: { ...PROVIDERS.ollama },
      probe: async () => ({ providerId: 'ollama', status: 'ready' }),
      listModels: async () => [],
      generate: async function* () {
        yield { text: 'a', sequence: 0 };
      },
      warmup: async () => {
        calls += 1;
        await gate;
      },
    });
    const coordinator = new SessionCoordinator({
      registry,
      getSettings: async () => ({
        sttProviderId: 'local-whisper',
        sttModelId: 'm',
        sttLanguage: 'auto',
        llmProviderId: 'ollama',
        llmModelId: 'test-llm',
        historyEnabled: false,
        historyRetentionDays: 7,
        maxClipSeconds: 90,
        answerMode: 'natural',
        targetSeconds: 30,
      }),
      getProfile: async () => null,
      saveHistory: async () => undefined,
      emit: () => undefined,
      recordError: () => undefined,
    });
    const first = coordinator.prewarm();
    const second = coordinator.prewarm();
    await tick();
    expect(calls).toBe(1);
    release();
    await Promise.all([first, second]);
    // Once settled, a later warmup is allowed again (the model may have been evicted).
    await coordinator.prewarm();
    expect(calls).toBe(2);
  });
});

describe('cloud speculation budget', () => {
  it('stops speculating after the per-clip cap; the final submit still transcribes', async () => {
    const h = makeHarness({ location: 'cloud' });
    for (let i = 1; i <= MAX_CLOUD_SPECULATIONS_PER_CLIP + 2; i++) {
      await h.coordinator.speculate(SID, wavOf(tone(3 * i), silence(0.7)), 'auto');
      await tick();
    }
    expect(h.sttCalls).toHaveLength(MAX_CLOUD_SPECULATIONS_PER_CLIP);
    await h.coordinator.submit(SID, wavOf(tone(20), silence(1.6)), OPTIONS, 5);
    expect(h.sttCalls).toHaveLength(MAX_CLOUD_SPECULATIONS_PER_CLIP + 1);
    expect(completed(h.events)).toBeTruthy();
  });

  it('resets the budget for a new session and never meters local passes', async () => {
    const cloud = makeHarness({ location: 'cloud' });
    for (let i = 1; i <= MAX_CLOUD_SPECULATIONS_PER_CLIP; i++) {
      await cloud.coordinator.speculate(SID, wavOf(tone(3 * i), silence(0.7)));
      await tick();
    }
    await cloud.coordinator.speculate(SID2, SNAPSHOT);
    await tick();
    expect(cloud.sttCalls).toHaveLength(MAX_CLOUD_SPECULATIONS_PER_CLIP + 1);

    const local = makeHarness({ location: 'local' });
    for (let i = 1; i <= MAX_CLOUD_SPECULATIONS_PER_CLIP + 2; i++) {
      await local.coordinator.speculate(SID, wavOf(tone(3 * i), silence(0.7)));
      await tick();
    }
    expect(local.sttCalls).toHaveLength(MAX_CLOUD_SPECULATIONS_PER_CLIP + 2);
  });
});
