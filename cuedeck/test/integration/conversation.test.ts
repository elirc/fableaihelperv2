import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../../src/main/providers/registry';
import type { AnswerRequest, LlmProvider, SttProvider } from '../../src/main/providers/contracts';
import { SessionCoordinator, type CoordinatorDeps } from '../../src/main/sessions/coordinator';
import { PROVIDERS } from '../../src/shared/catalog';
import type { AnswerDelta, PublicSettings, SessionEvent } from '../../src/shared/domain';
import { CoachError } from '../../src/shared/errors';
import { sineWav } from '../helpers/wav';

/**
 * Conversation memory, interviewer follow-ups, and the explicit backup
 * response model — the pieces that make a practice session behave like a
 * real multi-turn interview without silently changing where data goes.
 */

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SID2 = '11111111-2222-3333-4444-555555555555';
const SID3 = '22222222-3333-4444-5555-666666666666';
const OPTIONS = { answerMode: 'natural' as const, targetSeconds: 30 as const };

interface FakeLlm extends LlmProvider {
  requests: AnswerRequest[];
}

function fakeLlm(
  id: string,
  behaviour: (input: AnswerRequest, call: number) => AsyncIterable<AnswerDelta>,
  options: { installed?: string[]; location?: 'local' | 'cloud'; listFails?: boolean } = {},
): FakeLlm {
  const requests: AnswerRequest[] = [];
  return {
    meta: { ...PROVIDERS.ollama, id, location: options.location ?? 'local' },
    requests,
    probe: async () => ({ providerId: id, status: 'ready' }),
    listModels: async () => {
      if (options.listFails)
        throw new CoachError('LOCAL_PROVIDER_UNREACHABLE', 'nothing listening');
      return (options.installed ?? []).map((m) => ({
        id: m,
        displayName: m,
        providerId: id,
        installed: true,
      }));
    },
    generate: (input) => {
      requests.push(input);
      return behaviour(input, requests.length);
    },
  };
}

async function* say(text: string): AsyncIterable<AnswerDelta> {
  yield { text, sequence: 0 };
}

/** A generation that fails before producing anything. */
function failWith(code: ConstructorParameters<typeof CoachError>[0]): AsyncIterable<AnswerDelta> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        throw new CoachError(code);
      },
    }),
  };
}

function makeHarness(
  overrides: {
    primary?: FakeLlm;
    backup?: FakeLlm;
    conversationMemory?: boolean;
    transcript?: string;
    /** Configured response model; '' is the "never chose one" case. */
    llmModelId?: string;
  } = {},
) {
  const registry = new ProviderRegistry();
  let transcribeCount = 0;
  const stt: SttProvider = {
    meta: { ...PROVIDERS['local-whisper'] },
    probe: async () => ({ providerId: 'local-whisper', status: 'ready' }),
    listModels: async () => [],
    transcribe: async () => {
      transcribeCount += 1;
      return { text: overrides.transcript ?? `Question ${transcribeCount}?` };
    },
  };
  const primary = overrides.primary ?? fakeLlm('ollama', () => say('Primary answer.'));
  registry.registerStt(stt);
  registry.registerLlm(primary);
  if (overrides.backup) registry.registerLlm(overrides.backup);
  const events: SessionEvent[] = [];
  // Mutable, like the real store: a model the coordinator resolves is
  // written back and read by the next request.
  const settings = {
    sttProviderId: 'local-whisper',
    sttModelId: 'test-model',
    sttLanguage: 'auto',
    llmProviderId: primary.meta.id,
    llmModelId: overrides.llmModelId ?? 'primary-model',
    llmBackupProviderId: overrides.backup?.meta.id ?? '',
    llmBackupModelId: overrides.backup ? 'backup-model' : '',
    conversationMemory: overrides.conversationMemory ?? true,
    historyEnabled: false,
    historyRetentionDays: 7,
    maxClipSeconds: 90,
    answerMode: 'natural' as const,
    targetSeconds: 30 as const,
  };
  const patches: Partial<PublicSettings>[] = [];
  const deps: CoordinatorDeps = {
    registry,
    getSettings: async () => settings,
    updateSettings: async (patch) => {
      patches.push(patch);
      Object.assign(settings, patch);
    },
    getProfile: async () => null,
    saveHistory: async () => undefined,
    emit: (event) => events.push(event),
    recordError: () => undefined,
  };
  return { coordinator: new SessionCoordinator(deps), events, primary, patches, settings };
}

const userPromptOf = (llm: FakeLlm, index: number) => llm.requests[index].user;

describe('conversation memory', () => {
  it('sends earlier exchanges with the next request, oldest first', async () => {
    const { coordinator, primary } = makeHarness({});
    await coordinator.regenerate(SID, 'Tell me about a hard bug.', OPTIONS);
    await coordinator.regenerate(SID2, 'How did you find it?', OPTIONS);
    expect(userPromptOf(primary, 0)).not.toContain('<previous_exchanges>');
    const second = userPromptOf(primary, 1);
    expect(second).toContain('<previous_exchanges>');
    expect(second).toContain('<question>\nTell me about a hard bug.\n</question>');
    expect(second).toContain('<answer>\nPrimary answer.\n</answer>');
    expect(second.indexOf('<previous_exchanges>')).toBeLessThan(
      second.indexOf('<heard_transcript>'),
    );
  });

  it('keeps only the most recent exchanges', async () => {
    const { coordinator, primary } = makeHarness({});
    await coordinator.regenerate(SID, 'Q one?', OPTIONS);
    await coordinator.regenerate(SID2, 'Q two?', OPTIONS);
    await coordinator.regenerate(SID3, 'Q three?', OPTIONS);
    await coordinator.regenerate(SID, 'Q four?', OPTIONS);
    const fourth = userPromptOf(primary, 3);
    expect(fourth).not.toContain('Q one?');
    expect(fourth).toContain('Q two?');
    expect(fourth).toContain('Q three?');
  });

  it('replaces the exchange when the same question is regenerated (Try again, Shorter…)', async () => {
    const llm = fakeLlm('ollama', (_i, call) => say(`Answer v${call}.`));
    const { coordinator, primary } = makeHarness({ primary: llm });
    await coordinator.regenerate(SID, 'Same question?', OPTIONS);
    await coordinator.regenerate(SID2, 'Same question?', { ...OPTIONS, answerMode: 'concise' });
    await coordinator.regenerate(SID3, 'Next question?', OPTIONS);
    const third = userPromptOf(primary, 2);
    expect(third).toContain('Answer v2.');
    expect(third).not.toContain('Answer v1.');
    expect(third.match(/<question>/g)).toHaveLength(1);
  });

  it('reports the remembered depth after each answer and after clearing', async () => {
    const { coordinator, events, primary } = makeHarness({});
    await coordinator.regenerate(SID, 'Q?', OPTIONS);
    const depth = events.filter((e) => e.type === 'conversation');
    expect(depth).toHaveLength(1);
    expect(depth[0].type === 'conversation' && depth[0].exchanges).toBe(1);
    coordinator.clearConversation();
    await coordinator.regenerate(SID2, 'Fresh?', OPTIONS);
    expect(userPromptOf(primary, 1)).not.toContain('<previous_exchanges>');
  });

  it('records exchanges from the submit path too', async () => {
    const { coordinator, primary } = makeHarness({});
    await coordinator.submit(SID, sineWav(2), OPTIONS, 5);
    await coordinator.regenerate(SID2, 'Follow-up?', OPTIONS);
    expect(userPromptOf(primary, 1)).toContain('Question 1?');
  });

  it('sends nothing and remembers nothing when memory is off', async () => {
    const { coordinator, events, primary } = makeHarness({ conversationMemory: false });
    await coordinator.regenerate(SID, 'Q one?', OPTIONS);
    await coordinator.regenerate(SID2, 'Q two?', OPTIONS);
    expect(userPromptOf(primary, 1)).not.toContain('<previous_exchanges>');
    expect(events.some((e) => e.type === 'conversation')).toBe(false);
  });
});

describe('interviewer follow-up', () => {
  it('generates a question from the conversation and delivers it as a follow-up event', async () => {
    const llm = fakeLlm('ollama', (input) =>
      input.system.includes('You are the interviewer')
        ? say('"How did you measure the improvement?"')
        : say('Primary answer.'),
    );
    const { coordinator, events, primary } = makeHarness({ primary: llm });
    await coordinator.regenerate(SID, 'Tell me about a win.', OPTIONS);
    await coordinator.followUp(SID2, { sessionNotes: 'Acme, staff engineer' });
    const followUp = events.find((e) => e.type === 'follow-up');
    expect(followUp?.type === 'follow-up' && followUp.text).toBe(
      'How did you measure the improvement?',
    );
    expect(followUp?.sessionId).toBe(SID2);
    const request = primary.requests[1];
    expect(request.system).toContain('You are the interviewer');
    expect(request.user).toContain('<previous_exchanges>');
    expect(request.user).toContain('Tell me about a win.');
    expect(request.user).toContain('<session_notes>\nAcme, staff engineer\n</session_notes>');
    expect(request.maxTokens).toBeLessThanOrEqual(200);
    // The interviewer's question is not itself an exchange.
    expect(events.filter((e) => e.type === 'conversation')).toHaveLength(1);
    // A follow-up never produces an answer card.
    const own = events.filter((e) => e.sessionId === SID2);
    expect(own.some((e) => e.type === 'answer-delta' || e.type === 'answer-complete')).toBe(false);
    expect(events[events.length - 1]).toEqual({ type: 'state', sessionId: SID2, state: 'ready' });
  });

  it('refuses when there is nothing to follow up on', async () => {
    const { coordinator, events } = makeHarness({});
    await coordinator.followUp(SID, {});
    const error = events.find((e) => e.type === 'error');
    expect(error?.type === 'error' && error.error.code).toBe('TRANSCRIPT_EMPTY');
  });

  it('the follow-up then feeds the next answer as context', async () => {
    const llm = fakeLlm('ollama', (input) =>
      input.system.includes('You are the interviewer') ? say('Why that approach?') : say('A.'),
    );
    const { coordinator, primary } = makeHarness({ primary: llm });
    await coordinator.regenerate(SID, 'First?', OPTIONS);
    await coordinator.followUp(SID2, {});
    await coordinator.regenerate(SID3, 'Why that approach?', OPTIONS);
    const answerRequest = primary.requests[2];
    expect(answerRequest.user).toContain('<question>\nFirst?\n</question>');
    expect(answerRequest.user).toContain(
      '<heard_transcript>\nWhy that approach?\n</heard_transcript>',
    );
  });
});

/**
 * Onboarding can finish with no response model chosen (Ollama installed but
 * empty at the time, the model pulled afterwards). The request must resolve
 * one instead of asking the provider for the empty string.
 */
describe('empty response model', () => {
  it('answers on the first recommended installed model and writes the choice back', async () => {
    const primary = fakeLlm('ollama', () => say('Answer.'), {
      // Deliberately not in preference order: recommended beats first-listed.
      installed: ['mistral:latest', 'qwen2.5:3b-instruct', 'llama3.2:3b'],
    });
    const { coordinator, events, patches, settings } = makeHarness({ primary, llmModelId: '' });
    await coordinator.regenerate(SID, 'Q?', OPTIONS);
    expect(primary.requests[0].modelId).toBe('qwen2.5:3b-instruct');
    expect(patches).toEqual([{ llmModelId: 'qwen2.5:3b-instruct' }]);
    expect(settings.llmModelId).toBe('qwen2.5:3b-instruct');
    const done = events.find((e) => e.type === 'answer-complete');
    expect(done?.type === 'answer-complete' && done.metrics.llmModelId).toBe('qwen2.5:3b-instruct');
  });

  it('falls back to the first installed model when none is recommended', async () => {
    const primary = fakeLlm('ollama', () => say('Answer.'), { installed: ['mistral:latest'] });
    const { coordinator } = makeHarness({ primary, llmModelId: '' });
    await coordinator.regenerate(SID, 'Q?', OPTIONS);
    expect(primary.requests[0].modelId).toBe('mistral:latest');
  });

  it('resolves once and reuses the choice for later requests', async () => {
    const primary = fakeLlm('ollama', () => say('Answer.'), { installed: ['llama3.2:3b'] });
    const { coordinator, patches } = makeHarness({ primary, llmModelId: '' });
    await coordinator.prewarm();
    await coordinator.regenerate(SID, 'Q?', OPTIONS);
    await coordinator.regenerate(SID2, 'Q two?', OPTIONS);
    expect(patches).toHaveLength(1);
  });

  it('fails with MODEL_NOT_SELECTED when the local server has no models at all', async () => {
    const primary = fakeLlm('ollama', () => say('Answer.'), { installed: [] });
    const { coordinator, events, patches } = makeHarness({ primary, llmModelId: '' });
    await coordinator.regenerate(SID, 'Q?', OPTIONS);
    const error = events.find((e) => e.type === 'error');
    expect(error?.type === 'error' && error.error.code).toBe('MODEL_NOT_SELECTED');
    expect(primary.requests).toHaveLength(0);
    expect(patches).toHaveLength(0);
  });

  it('keeps LOCAL_PROVIDER_UNREACHABLE when the local server cannot be listed', async () => {
    const primary = fakeLlm('ollama', () => say('Answer.'), { listFails: true });
    const { coordinator, events } = makeHarness({ primary, llmModelId: '' });
    await coordinator.regenerate(SID, 'Q?', OPTIONS);
    const error = events.find((e) => e.type === 'error');
    expect(error?.type === 'error' && error.error.code).toBe('LOCAL_PROVIDER_UNREACHABLE');
    expect(primary.requests).toHaveLength(0);
  });

  it('fails with MODEL_NOT_SELECTED for a cloud provider rather than sending an empty model', async () => {
    const primary = fakeLlm('groq', () => say('Answer.'), {
      location: 'cloud',
      installed: ['some-cloud-model'],
    });
    const { coordinator, events, patches } = makeHarness({ primary, llmModelId: '' });
    await coordinator.regenerate(SID, 'Q?', OPTIONS);
    const error = events.find((e) => e.type === 'error');
    expect(error?.type === 'error' && error.error.code).toBe('MODEL_NOT_SELECTED');
    expect(error?.type === 'error' && error.error.retryable).toBe(false);
    expect(primary.requests).toHaveLength(0);
    expect(patches).toHaveLength(0);
  });

  it('resolves the model on the submit path too, before transcribing', async () => {
    const primary = fakeLlm('ollama', () => say('Answer.'), { installed: ['qwen3:8b'] });
    const { coordinator, events } = makeHarness({ primary, llmModelId: '' });
    await coordinator.submit(SID, sineWav(2), OPTIONS, 5);
    expect(primary.requests[0].modelId).toBe('qwen3:8b');
    const done = events.find((e) => e.type === 'answer-complete');
    expect(done?.type === 'answer-complete' && done.metrics.llmModelId).toBe('qwen3:8b');
  });
});

describe('backup response model', () => {
  it('answers on the backup when the primary is rate-limited before its first token', async () => {
    const primary = fakeLlm('ollama', () => failWith('PROVIDER_RATE_LIMITED'));
    const backup = fakeLlm('cerebras', () => say('Backup answer.'));
    const { coordinator, events } = makeHarness({ primary, backup });
    await coordinator.regenerate(SID, 'Q?', OPTIONS);
    const done = events.find((e) => e.type === 'answer-complete');
    expect(done?.type === 'answer-complete' && done.text).toBe('Backup answer.');
    expect(done?.type === 'answer-complete' && done.metrics.usedBackup).toBe(true);
    expect(done?.type === 'answer-complete' && done.metrics.llmProviderId).toBe('cerebras');
    expect(done?.type === 'answer-complete' && done.metrics.llmModelId).toBe('backup-model');
    expect(backup.requests[0].modelId).toBe('backup-model');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('does not switch once the primary has started answering', async () => {
    const primary = fakeLlm('ollama', async function* () {
      yield { text: 'Half an ', sequence: 0 };
      throw new CoachError('PROVIDER_UNAVAILABLE');
    });
    const backup = fakeLlm('cerebras', () => say('Backup answer.'));
    const { coordinator, events } = makeHarness({ primary, backup });
    await coordinator.regenerate(SID, 'Q?', OPTIONS);
    expect(backup.requests).toHaveLength(0);
    const error = events.find((e) => e.type === 'error');
    expect(error?.type === 'error' && error.error.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('surfaces the primary error when no backup is configured', async () => {
    const primary = fakeLlm('ollama', () => failWith('PROVIDER_RATE_LIMITED'));
    const { coordinator, events } = makeHarness({ primary });
    await coordinator.regenerate(SID, 'Q?', OPTIONS);
    const error = events.find((e) => e.type === 'error');
    expect(error?.type === 'error' && error.error.code).toBe('PROVIDER_RATE_LIMITED');
  });

  it('surfaces the backup error when both fail', async () => {
    const primary = fakeLlm('ollama', () => failWith('PROVIDER_RATE_LIMITED'));
    const backup = fakeLlm('cerebras', () => failWith('PROVIDER_UNAVAILABLE'));
    const { coordinator, events } = makeHarness({ primary, backup });
    await coordinator.regenerate(SID, 'Q?', OPTIONS);
    const error = events.find((e) => e.type === 'error');
    expect(error?.type === 'error' && error.error.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('a primary that streams nothing at all engages the backup', async () => {
    // A 200 whose SSE body carries no text (captive portal, an unrecognised
    // upstream failure frame) used to end the session with an empty answer.
    const primary = fakeLlm('ollama', async function* () {
      /* no deltas */
    });
    const backup = fakeLlm('cerebras', () => say('Backup answer.'));
    const { coordinator, events } = makeHarness({ primary, backup });
    await coordinator.regenerate(SID, 'Q?', OPTIONS);
    const done = events.find((e) => e.type === 'answer-complete');
    expect(done?.type === 'answer-complete' && done.text).toBe('Backup answer.');
    expect(done?.type === 'answer-complete' && done.metrics.usedBackup).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('without a backup an empty stream fails the session instead of completing an empty answer', async () => {
    const primary = fakeLlm('ollama', async function* () {
      /* no deltas */
    });
    const { coordinator, events } = makeHarness({ primary });
    await coordinator.regenerate(SID, 'Q?', OPTIONS);
    expect(events.some((e) => e.type === 'answer-complete')).toBe(false);
    expect(events.some((e) => e.type === 'conversation')).toBe(false);
    const error = events.find((e) => e.type === 'error');
    expect(error?.type === 'error' && error.error.code).toBe('PROVIDER_UNAVAILABLE');
    // Nothing was remembered: the next request carries no empty exchange.
    await coordinator.regenerate(SID2, 'Next?', OPTIONS);
    expect(userPromptOf(primary, 1)).not.toContain('<previous_exchanges>');
  });

  it('never uses the backup for a cancelled session', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const primary = fakeLlm('ollama', async function* (input) {
      await gate;
      if (input.signal.aborted) throw new DOMException('aborted', 'AbortError');
      yield { text: 'x', sequence: 0 };
    });
    const backup = fakeLlm('cerebras', () => say('Backup answer.'));
    const { coordinator, events } = makeHarness({ primary, backup });
    const run = coordinator.regenerate(SID, 'Q?', OPTIONS);
    await new Promise((resolve) => setTimeout(resolve, 10));
    coordinator.cancel(SID);
    release();
    await run;
    expect(backup.requests).toHaveLength(0);
    expect(events.some((e) => e.type === 'answer-complete')).toBe(false);
  });
});
